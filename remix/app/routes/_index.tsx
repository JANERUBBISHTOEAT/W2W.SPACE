import { GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import { ActionFunctionArgs, json, LoaderFunction } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
} from "@remix-run/react";
import dotenv from "dotenv";
import { jwtDecode } from "jwt-decode";
import { useEffect, useRef, useState } from "react";
import invariant from "tiny-invariant";
import { toast } from "sonner";
import { mergeFiles } from "~/utils/data.server";
import { prettyBytes } from "~/utils/functions";
import HashMap from "~/utils/hashmap.server";
import {
  commitSession,
  destroySession,
  getSession,
  getUserSession,
  getVisitorSession,
} from "~/utils/session.server";

if (typeof window === "undefined") {
  // Server-side
  dotenv.config();
}

export const loader: LoaderFunction = async ({ request }) => {
  const user = await getUserSession(request);
  return json({ googleClientId: process.env.GOOGLE_CLIENT_ID, user: user });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  console.log("Action params:", params);

  // Check intent
  const formData = await request.formData();
  const formObj = Object.fromEntries(formData);
  console.log("formObj:", formObj);
  invariant(formObj.intent, "No intent found");

  // * Is OAuth callback
  if (formObj.intent === "OAuthCallback") {
    console.log("intent: OAuthCallback");
    const credential = formObj.credential as string;
    const decoded = jwtDecode(credential);
    console.log("Decoded:", decoded);

    // Login user
    const session = await getSession(request);
    session.set("user", decoded);

    // Merge visitor session
    const visitor = await getVisitorSession(request);
    if (visitor) {
      if (decoded.sub && visitor.sub) {
        mergeFiles(decoded.sub, visitor.sub);
      } else {
        console.error("User ID or Visitor ID is undefined");
      }
    }

    return json(
      { user: decoded },
      { headers: { "Set-Cookie": await commitSession(session) } },
    );
  }

  // * Is Logout
  if (formObj.intent === "Logout") {
    console.log("intent: Logout");
    const session = await getSession(request);

    return json(
      { user: null },
      { headers: { "Set-Cookie": await destroySession(session) } },
    );
  }

  // * Is acquireMagnet
  if (formObj.intent === "acquireMagnet") {
    console.log("intent: acquireMagnet");
    const token = formObj.token as string;

    // Check if it's a text token first
    const textId = await HashMap.getText(token);
    if (textId) {
      return json({
        intent: "acquireMagnet",
        textId: textId,
        magnet: null,
        type: "text",
      });
    }

    // Otherwise try file token
    // For backward compatibility, HashMap.get() returns fileId which we can use to look up the magnet
    const result = await HashMap.getBoth(token);
    if (result.fileId) {
      return json({
        intent: "acquireMagnet",
        fileId: result.fileId,
        magnet: null, // Will be retrieved in client code
        type: "file",
      });
    }

    return json({
      intent: "acquireMagnet",
      magnet: null,
      type: null,
    });
  }
};

export default function Index() {
  const { googleClientId, user: initialUser } = useLoaderData<{
    googleClientId: string;
    user: Record<string, any>;
  }>();
  const location = useLocation();
  const [torrent, setTorrent] = useState<any | null>(null);
  const clientRef = useRef<any | null>(null);
  const client_id = googleClientId || "";
  const fetcher = useFetcher<any>();
  const restoreFetcher = useFetcher<{
    success?: boolean;
    url?: string;
    error?: string;
  }>();
  const restoreHandledRef = useRef(false);
  const navigate = useNavigate();
  const [loggedIn, setLoggedIn] = useState(initialUser ? true : false);
  const [user, setUser] = useState<Record<string, any> | null>(null);
  const debounceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadModule() {
    console.log("Loading WebTorrent module");
    if (typeof window !== "undefined" && !clientRef.current) {
      import("webtorrent").then((WebTorrent) => {
        clientRef.current = new WebTorrent.default();
        console.log("WebTorrent client ready", clientRef.current);
      });
    }
  }

  // Handle global paste event
  async function handlePaste(event: ClipboardEvent) {
    // [x]: Listen file paste all the time
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    for (let i = 0; i < items.length; i++) {
      // string (token or magnet)
      if (items[i].kind === "string") {
        console.log("Global string paste event:", items[i]);
        items[i].getAsString((text) => {
          let _type = "";
          if (/^\d+$/.test(text)) _type = "token";
          else if (text.startsWith("magnet:?")) _type = "magnet";
          else return;
          (document.getElementsByName(_type)[0] as HTMLInputElement).value =
            text;
          // Add redirect to `_index` here if `global_paste_listener`
          // is enable on all pages in the future
          handleDownload(text, _type);
        });
        return;
      }

      // file (go to new file page)
      if (items[i].kind === "file") {
        const file = items[i].getAsFile();
        console.log("Global file paste event:", file);
        if (!file) continue;

        const fileURL = URL.createObjectURL(file);
        localStorage.setItem("fileURL", fileURL);
        const formData = new FormData();
        formData.append("fileName", file.name);
        formData.append("mimeType", file.type);
        fetcher.submit(formData, {
          method: "POST",
          action: "/api/new/file",
        });
      }
      return;
    }
  }

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    // ? Remove global on exit _index or not
    // [ ] Remove event listener lessen pages where paste works
    // [ ] Keep event listener makes too many reacts
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, []);

  useEffect(() => {
    loadModule();
  }, []);

  // Old code: debounce function (commented out)
  // const debounce = (value: string, type: string) => {
  //   if (debounceTimeout.current) {
  //     clearTimeout(debounceTimeout.current);
  //   }

  //   // Clear input CSS
  //   const token_elem = document.getElementById(
  //     "tokenInput"
  //   ) as HTMLInputElement;
  //   const magnet_elem = document.getElementById(
  //     "magnetInput"
  //   ) as HTMLInputElement;

  //   if (type === "token") {
  //     token_elem.className = "";
  //   } else {
  //     magnet_elem.className = "";
  //   }
  //   void token_elem.offsetWidth;

  //   debounceTimeout.current = setTimeout(() => {
  //     handleDownload(value, type);
  //   }, 500);
  // };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    type: string,
  ) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLInputElement;
      const value = target.value.trim();
      if (value) {
        handleDownload(value, type);
      }
    }

    // Clear input CSS
    const token_elem = document.getElementById(
      "tokenInput",
    ) as HTMLInputElement;
    const magnet_elem = document.getElementById(
      "magnetInput",
    ) as HTMLInputElement;

    if (type === "token") {
      token_elem.className = "";
    } else {
      magnet_elem.className = "";
    }
    void token_elem.offsetWidth;
  };

  const handleDownload = async (magnet_or_token: string, type: string) => {
    invariant(magnet_or_token, "No magnet link provided");

    // Load module if not ready
    if (!clientRef.current) {
      toast.error("Client not ready. Please try again later.");
      console.error("Client not ready", clientRef.current);
      loadModule();
      return;
    }

    // Get magnet link if token
    // ! Cannot get response here, use useEffect in Index()
    if (type === "token") {
      // * Is token, get magnet link & save to history
      console.log("Downloading using token:", magnet_or_token);
      // Fetch magnet link
      const formData = new FormData();
      formData.append("intent", "acquireMagnet");
      formData.append("token", magnet_or_token);
      fetcher.submit(formData, {
        method: "POST",
        action: "/api/" + "new" + "/token",
      });
    } else {
      // * Is magnet, get token & save to history
      console.log("Downloading using magnet:", magnet_or_token);
      const formData = new FormData();
      formData.append("intent", "acquireToken");
      formData.append("magnet", magnet_or_token);
      fetcher.submit(formData, {
        method: "POST",
        action: "/api/" + "new" + "/token",
      });
    }
  };

  // After restore API success: navigate to restored file/text (once per response)
  useEffect(() => {
    if (restoreFetcher.state !== "idle" || !restoreFetcher.data) return;
    const d = restoreFetcher.data;
    if (d.success && d.url && !restoreHandledRef.current) {
      restoreHandledRef.current = true;
      toast.success("Restored");
      navigate(d.url);
    } else if (d.error) {
      toast.error(d.error);
    }
  }, [restoreFetcher.state, restoreFetcher.data, navigate]);
  // Reset so next restore can navigate again
  useEffect(() => {
    if (
      restoreFetcher.state === "submitting" ||
      restoreFetcher.state === "loading"
    ) {
      restoreHandledRef.current = false;
    }
  }, [restoreFetcher.state]);

  const shownMessageKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const message = search.get("message");
    const undoId = search.get("undoId");
    const undoType = search.get("undoType");
    if (!message) return;
    const key = `${location.pathname}:${location.search}`;
    if (shownMessageKeyRef.current === key) return;
    shownMessageKeyRef.current = key;
    if (
      message === "Deleted" &&
      undoId &&
      (undoType === "file" || undoType === "text")
    ) {
      toast.success("Deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            const fd = new FormData();
            fd.append("undoId", undoId);
            fd.append("undoType", undoType);
            restoreFetcher.submit(fd, {
              method: "POST",
              action: "/api/restore",
            });
          },
        },
      });
    } else if (message === "Deleted") {
      toast.success("Deleted");
    } else {
      toast.info(message);
    }
    window.history.replaceState({}, "", location.pathname);
  }, [location]);

  useEffect(() => {
    if (!fetcher.data) {
      // console.error("No data found");
      return;
    }

    console.log("Fetcher data:", fetcher.data);

    // Acquire user data
    if ("user" in fetcher.data) {
      setUser(fetcher.data.user);
      return;
    }

    const token_elem = document.getElementById(
      "tokenInput",
    ) as HTMLInputElement;
    const magnet_elem = document.getElementById(
      "magnetInput",
    ) as HTMLInputElement;

    // [x] Acquire magnet link & save to history
    if (fetcher.data?.intent === "acquireMagnet") {
      // Check if it's a text token
      if (fetcher.data?.type === "text" && fetcher.data?.textId) {
        console.log("Redirecting to text:", fetcher.data.textId);
        window.location.href = `/texts/${fetcher.data.textId}`;
        return;
      }

      // Check if it's a file token
      if (fetcher.data?.type === "file") {
        token_elem.className = "";
        void token_elem.offsetWidth;
        token_elem.classList.add("correct-input");
      } else {
        console.error("Token not found");
        token_elem.className = "";
        void token_elem.offsetWidth;
        token_elem.classList.add("wrong-input");
        return;
      }
    }

    // [x] Tested download by magnet link
    else if (fetcher.data?.intent === "acquireToken") {
      console.log("Acquiring token...");
      const target = magnet_elem ?? token_elem;
      if (!fetcher.data?.token) {
        console.error("No token found");
        console.error("No token found");
        target.className = "";
        void target.offsetWidth;
        target.classList.add("wrong-input");
        // return;
      } else {
        console.log("Token acquired:", fetcher.data.token);
        // Pulse anyway
        target.className = "";
        void target.offsetWidth;
        target.classList.add("correct-input");
      }
    }

    const magnet = fetcher.data.magnet;
    const torrent = clientRef.current.add(magnet);
    console.log("Client is downloading:", torrent.infoHash);
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }
    setTorrent(torrent);

    const DOWNLOAD_TOAST_ID = "download-progress";
    toast.loading("Downloading 0%", { id: DOWNLOAD_TOAST_ID });

    const progress_div: any = document.getElementById("progress");
    const down_speed_div: any = document.getElementById("down_speed");
    const up_speed_div: any = document.getElementById("up_speed");
    const peers_div: any = document.getElementById("peers");

    torrent.on("ready", () => {
      console.log("Download started.");
      if (progress_div) progress_div.innerHTML = `Progress: ${(0).toFixed(2)}%`;
      if (fetcher.data?.fileId) {
        const formData = new FormData();
        formData.append("intent", "updateFile");
        formData.append("fileid", fetcher.data.fileId);
        formData.append("magnet", torrent.magnetURI);
        formData.append("filename", torrent.name);
        formData.append("filesize", torrent.length);
        formData.append("filetype", torrent.files[0].type);
        fetcher.submit(formData, {
          method: "POST",
          action: "/api/files",
        });
      }
    });

    torrent.on("download", () => {
      const pct = (torrent.progress * 100).toFixed(1);
      console.log(`Progress: ${pct}%`);
      if (torrent.progress === 1.0) {
        if (progress_div) progress_div.innerHTML = `Progress: 100%`;
        if (down_speed_div) down_speed_div.innerHTML = "";
        if (up_speed_div) up_speed_div.innerHTML = "";
        if (peers_div) peers_div.innerHTML = "";
      } else {
        if (progress_div) progress_div.innerHTML = `Progress: ${pct}%`;
        if (down_speed_div)
          down_speed_div.innerHTML = `Download speed: ${prettyBytes(
            torrent.downloadSpeed,
          )}/s`;
        if (up_speed_div)
          up_speed_div.innerHTML = `Upload speed: ${prettyBytes(
            torrent.uploadSpeed,
          )}/s`;
        if (peers_div) peers_div.innerHTML = `Peers: ${torrent.numPeers}`;
      }
      const desc =
        torrent.progress < 1
          ? `${prettyBytes(torrent.downloadSpeed)}/s · ${
              torrent.numPeers
            } peers`
          : undefined;
      toast.loading(`Downloading ${pct}%`, {
        id: DOWNLOAD_TOAST_ID,
        description: desc,
      });
    });

    torrent.on("done", async () => {
      console.log("Download finished.");
      if (progress_div) progress_div.innerHTML = `Progress: 100%`;
      toast.dismiss(DOWNLOAD_TOAST_ID);
      toast.success("Download finished! Your file is ready for use 🎉");
      if (token_elem) {
        token_elem.value = "";
        token_elem.className = "";
      }
      if (magnet_elem) {
        magnet_elem.value = "";
        magnet_elem.className = "";
      }
      for (const file of torrent.files) {
        console.log("File:", file);
        downloadTorrentFile(file);
      }
    });
  }, [fetcher.data]);

  async function downloadTorrentFile(file: any) {
    const blob = await file.blob();
    console.log("Blob:", blob);
    const url = URL.createObjectURL(blob);

    const index_elem = document.getElementById("fileList") as HTMLElement;
    const a = document.createElement("a");
    const d = document.createElement("div");
    a.href = url;
    a.innerText = "Download file" + file.name;
    a.download = file.name;
    a.click();
    d.appendChild(a);
    index_elem.appendChild(d);
  }

  const handleLogin = (credentialResponse: any) => {
    fetcher.load(".");
    fetcher.submit(
      {
        intent: "OAuthCallback",
        credential: credentialResponse.credential || "",
      },
      {
        method: "POST",
        action: ".",
      },
    );
    setLoggedIn(true);
  };

  const handleLogout = () => {
    fetcher.load(".");
    fetcher.submit(
      {
        intent: "Logout",
      },
      {
        method: "POST",
        action: ".",
      },
    );
    setLoggedIn(false);
  };

  return (
    <div id="index-page">
      <div className="">
        {/* [x]: Make a soft warning here not Swal */}
        <p>Receive using your token:</p>
        <input
          type="text"
          name="token"
          title="💡Try pasting onto page without clicking"
          onKeyDown={(e) => {
            handleKeyDown(e, "token");
          }}
          id="tokenInput"
        />
      </div>

      {/* Old code: magnet link input (commented out) */}
      {/* <div className="">
        <p>or using magnet link:</p>
        <input
          type="text"
          name="magnet"
          title="💡Same thing for magnets or even files :)"
          onKeyDown={(e) => {
            handleKeyDown(e, "magnet");
          }}
          id="magnetInput"
        />
      </div> */}

      {/* <div id="progress"></div>
      <div id="down_speed"></div>
      <div id="up_speed"></div>
      <div id="peers"></div> */}

      <div id="fileList"></div>

      <div className="google-login-container">
        <div className={loggedIn ? "" : "hidden"}>
          <p>
            You are logged in as {user?.name || initialUser?.name || "visitor"}
          </p>
          <button
            onClick={() => {
              handleLogout();
            }}
          >
            Logout
          </button>
        </div>
        <GoogleOAuthProvider clientId={client_id}>
          <div className={loggedIn ? "hidden" : "login-button"}>
            <p>log in to sync file history:</p>
            <GoogleLogin
              onSuccess={(credentialResponse) => {
                console.log(credentialResponse);
                handleLogin(credentialResponse);
              }}
              onError={() => {
                console.log("Login Failed");
              }}
            />
          </div>
        </GoogleOAuthProvider>
      </div>

      <div className="footer">
        <a
          className="visitor-badge"
          href="https://visitorbadge.io/status?path=https%3A%2F%2Fw2w.space%2F"
        >
          <img
            src={
              "https://api.visitorbadge.io/api/combined?" +
              "path=https%3A%2F%2Fw2w.space%2F&" +
              "countColor=%2337d67a&" +
              "style=plastic&labelStyle=none"
            }
            alt="Visitor badge"
          />
        </a>
        <a
          className="github-link"
          href="https://github.com/JANERUBBISHTOEAT/CSCC09-24F-Project?tab=readme-ov-file#why-w2w"
        >
          | Why W2W?
        </a>
        <a
          className="github-link"
          href="https://github.com/JANERUBBISHTOEAT/CSCC09-24F-Project"
        >
          | View on GitHub
        </a>
      </div>
    </div>
  );
}
