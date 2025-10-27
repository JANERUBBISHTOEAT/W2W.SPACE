import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import Swal from "sweetalert2";
import invariant from "tiny-invariant";
import toastr from "toastr";
import { fileIconMap } from "~/utils/constants";
import { deleteFile, getFile, updateFile } from "~/utils/data.server";
import { useBlocker } from "react-router-dom";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const userId = user?.sub || visitor?.sub;
  const file = await getFile(userId, params.fileId);
  console.log("File @loader:", file);
  if (!file) {
    return redirect("/?message=Page+Not+Found");
  }

  // Check if file is marked as deleted in unifiedTokenMap
  if (file.token) {
    const HashMap = (await import("~/utils/hashmap.server")).default;
    const tokenStatus = await HashMap.getBoth(file.token);
    if (tokenStatus.status === "deleted") {
      return redirect(`/files/${params.fileId}/deleted_`);
    }
  }

  // Update access statistics
  const now = new Date().toISOString();
  const updatedFile = {
    ...file,
    lastAccessedAt: now,
    accessCount: (file.accessCount || 0) + 1,
  };
  await updateFile(userId, params.fileId, updatedFile);

  const url = new URL(request.url);
  const searchParams = url.searchParams;
  params = {
    pasted: searchParams.get("pasted") || undefined,
    fileName: searchParams.get("fileName") || undefined,
    mimeType: searchParams.get("mimeType") || undefined,
  };
  return json({ file: updatedFile, params: params });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  console.log("Action params:", params);
  invariant(params.fileId, "Missing fileId param");

  // Check intent
  const formData = await request.formData();
  const formObj = Object.fromEntries(formData);
  console.log("formObj:", formObj);

  // Get file which is gonna use anyway
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const file = await getFile(user?.sub || visitor?.sub, params.fileId);
  if (!file) {
    redirect("/?message=Page+Not+Found");
    throw new Response("Not Found", { status: 404 });
  }
  console.log("File @action:", file);

  // * is human cancel submission
  if (formObj.intent === "cancelSubmission") {
    console.log("intent: cancelSubmission");
    // if file is newly created, delete it
    if (!file.magnet) {
      deleteFile(user?.sub || visitor?.sub, params.fileId);
    }

    // else, don't save changes
    // * no need to redirect, client side will navigate(-1)
    return null;
  }

  // * Is human clicking button
  console.log("intent: saveFile");

  // No file or link provided, delete this record
  if (!formObj.fileName || !formObj.magnet) {
    deleteFile(user?.sub || visitor?.sub, params.fileId);
    return redirect("/?message=File+not+saved");
  }

  const updates = {
    filename: formObj.fileName || file.filename || params.fileId || "",
    type: formObj.fileType || file.type || "",
    size: formObj.fileSize || file.size || -1,
    magnet: formObj.magnet || file.magnet || "",
    token: formObj.token || file.token || "",
    notes: formObj.notes || file.notes || "",
  };

  console.log("Updates:", updates);

  const now = new Date().toISOString();
  const newFile = await updateFile(user?.sub || visitor?.sub, params.fileId, {
    ...updates,
    lastEditedAt: now,
  } as any);
  // [x]: Update token element
  return redirect(`/files/${newFile.id}/?message=File+saved`);
};

export default function EditFile() {
  const { file: dbFileJson, params: params } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null); // [x] Used for react state
  const [token, setToken] = useState<string | null>(null);
  const [torrent, setTorrent] = useState<any | null>(null);
  const fetcher = useFetcher();

  const clientRef = useRef<any | null>(null);

  async function loadModule() {
    console.log("Loading WebTorrent module");
    if (typeof window !== "undefined" && !clientRef.current) {
      import("webtorrent").then((WebTorrent) => {
        clientRef.current = new WebTorrent.default();
        console.log("WebTorrent client ready", clientRef.current);
      });
    }
  }

  // Handle local paste event
  async function handlePaste(event: ClipboardEvent) {
    // [x]: Remove handler on leave edit page
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file") {
        const file = items[i].getAsFile();
        console.log("Local file paste event:", file);
        if (file) {
          setFile(file);
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          handleSubmit(dataTransfer.files);
        }
      }
    }
  }

  async function urlToFile(fileURL: string, params: any) {
    const response = await fetch(fileURL);
    const blob = await response.blob();
    return new File([blob], params.fileName, { type: params.mimeType });
  }

  useEffect(() => {
    loadModule();
    const fileURL = localStorage.getItem("fileURL");
    localStorage.removeItem("fileURL");
    if (params.pasted && fileURL) {
      console.log("Local handler receive fileURL:", fileURL);
      urlToFile(fileURL, params).then((file) => {
        console.log("Local handler reconstructed file:", file);
        setFile(file);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        handleSubmit(dataTransfer.files);
      });
    }
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, []);

  // const blocker = useBlocker(() => isBlocking);
  // useEffect(() => {
  //   if (blocker.state === "blocked") {
  //     Swal.fire({
  //       title: "Stay on page to keep seeding",
  //       text: "Stay on page to keep seeding",
  //       icon: "info",
  //       showCancelButton: true,
  //       confirmButtonText: "Stay",
  //       cancelButtonText: "Leave",
  //       showCloseButton: true,
  //     }).then((result) => {
  //       if (result.isConfirmed) {
  //         blocker.reset(); // Cancel navigation
  //       } else {
  //         blocker.proceed(); // Continue navigation
  //       }
  //     });
  //   }
  // }, [blocker]);

  // const [isBlocking, setIsBlocking] = useState(false);
  // useEffect(() => {
  //   const handleBeforeUnload = (event: BeforeUnloadEvent) => {
  //     if (isBlocking) {
  //       event.preventDefault();
  //       // event.returnValue = "LEAVE_CONFIRMATION";
  //     }
  //   };
  //   window.addEventListener("beforeunload", handleBeforeUnload);
  //   return () => {
  //     window.removeEventListener("beforeunload", handleBeforeUnload);
  //   };
  // }, [isBlocking]);

  const handleSubmit = (files: FileList | null) => {
    // [x]: Update element (should modify element || order)
    invariant(files, "No file selected");
    if (!clientRef.current || !files) {
      Swal.fire({
        icon: "error",
        title: "Torrent client not ready",
        text: "Please try again later",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
      });
      console.error("Client not ready", clientRef.current);
      loadModule();
      return;
    }

    // Seed the file
    // setIsBlocking(true);
    const selectedFile = files[0];
    clientRef.current.seed(selectedFile, async (torrent: any) => {
      console.log("Client is seeding:", torrent.magnetURI);
      clearTimeout(timeoutId);
      setTorrent(torrent);

      // [x] Call action with intend to acquire token
      const formData = new FormData();
      formData.append("intent", "acquireToken");
      formData.append("magnet", torrent.magnetURI);
      fetcher.submit(formData, {
        method: "POST",
        action: "/api/" + dbFileJson.id + "/token",
      });

      Swal.fire({
        icon: "success",
        title: "File seeded!",
        text: "Your link is ready for sharing 🎉",
        showConfirmButton: false,
        timer: 2500,
        timerProgressBar: true,
      });
    });

    const timeoutId = setTimeout(() => {
      // Prompt user that file is being seeded
      console.log("Seeding in progress, please wait...");
      toastr.info("Seeding in progress, please wait...");
    }, 1000);
  };

  useEffect(() => {
    if (fetcher.data) {
      console.log("Response data:", fetcher.data);
      const receivedToken = fetcher.data.token || "";
      setToken(receivedToken);

      // Copy token to clipboard
      navigator.clipboard.writeText(receivedToken).then(
        () => {
          console.log("Token copied to clipboard");
          toastr.success("Token copied to clipboard");
        },
        (err) => {
          console.error("Failed to copy token: ", err);
          toastr.error("Failed to copy token");
        }
      );
    }
  }, [fetcher.data]);

  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>) => {
    let text: HTMLInputElement | null = null;
    if (event.currentTarget.id === "copy-magnet") {
      text = document.querySelector("input[name=magnet]");
    } else if (event.currentTarget.id === "copy-token") {
      text = document.querySelector("input[name=token]");
    } else {
      console.error("Unknown copy target");
      return;
    }

    if (text instanceof HTMLInputElement) {
      // text.select();
      navigator.clipboard.writeText(text.value).then(
        () => {
          console.log("Token copied to clipboard");
          toastr.success("Token copied to clipboard");
        },
        (err) => {
          console.error("Failed to copy token: ", err);
          toastr.error("Failed to copy token");
        }
      );
    }
  };

  return (
    // File drop zone
    <Form
      key={dbFileJson.id}
      id="contact-form"
      method="post"
      // encType="multipart/form-data"
    >
      <div
        id="dropzone"
        title="💡Stay on page to keep seeding"
        // htmlFor="fileInput"
        onDrop={(event) => {
          event.preventDefault();
          const droppedFile = event.dataTransfer.files[0];
          if (droppedFile) {
            setFile(droppedFile);
            handleSubmit(event.dataTransfer.files);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onClick={() => document.getElementById("fileInput")?.click()}
      >
        <i
          className={
            (file
              ? fileIconMap[file.type] || "fas fa-file"
              : "fas fa-file-upload") + " fa-2x file-icon"
          }
        ></i>
        {file ? (
          <div>{file.name}</div>
        ) : (
          <div className="grey">Drag & Drop files here</div>
        )}
        <input
          type="file"
          name="file"
          title="Upload file"
          onChange={(e) => {
            const selectedFile = e.target.files ? e.target.files[0] : null;
            if (!selectedFile) return; // Do not flush
            setFile(selectedFile);
            handleSubmit(e.target.files);
          }}
          id="fileInput"
        />
      </div>

      <p>
        <span>Name</span>
        <input
          aria-label="Filename"
          name="fileName"
          value={file?.name || dbFileJson.filename || ""}
          placeholder="Filename"
          type="text"
          readOnly
        />
        <input
          aria-label="Token"
          name="token"
          value={token || dbFileJson.token || ""}
          placeholder="Token"
          type="text"
          disabled
          readOnly
        />
        <button id="copy-token" type="button" onClick={handleCopy}>
          Copy
        </button>
      </p>
      {/* <label className="hidden">
        <span>Share with</span>
        <input
          defaultValue={dbFileJson.notes || ""}
          name="share"
          placeholder="TODO"
          type="text"
          disabled
          readOnly
        />
      </label> */}
      <label>
        <span>File Link</span>
        <input
          name="_magnet"
          value={torrent?.magnetURI || dbFileJson.magnet || ""}
          placeholder="magnet:?"
          type="text"
          // type="password"
          disabled
          readOnly
        />
        <input
          className="hidden"
          type="text"
          name="magnet"
          value={torrent?.magnetURI || dbFileJson.magnet || ""}
          readOnly
        />
        <button id="copy-magnet" type="button" onClick={handleCopy}>
          Copy
        </button>
      </label>
      <label>
        <span>Notes</span>
        <textarea defaultValue={dbFileJson.notes || ""} name="notes" rows={6} />
      </label>
      <input
        type="hidden"
        name="fileType"
        value={file?.type || dbFileJson.type || ""}
        readOnly
      />
      <input
        type="hidden"
        name="fileSize"
        value={file?.size || dbFileJson.size || -1}
        readOnly
      />

      <p>
        <button type="submit">Save</button>
        <button
          onClick={async () => {
            fetcher.submit(
              { intent: "cancelSubmission" },
              { method: "POST", action: `.` }
            );
            navigate(-1);
          }}
          type="button"
        >
          Cancel
        </button>
      </p>
    </Form>
  );
}
