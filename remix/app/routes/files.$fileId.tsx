import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  data,
  redirect,
  Form,
  useFetcher,
  useLoaderData,
  useLocation,
} from "react-router";
import type { FunctionComponent } from "react";
import { useEffect, useRef } from "react";
import invariant from "tiny-invariant";
import { toast } from "sonner";
import { fileIconMap } from "~/utils/constants";
import type { FileRecord } from "~/utils/data.server";
import { getFile, getFileByFileId, updateFile } from "~/utils/data.server";
import { getUserSession, getVisitorSession, requireSessionIdentity } from "~/utils/session.server";
import { prettyBytes } from "~/utils/functions";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const userId = user?.sub || visitor?.sub;

  // Try to get file by userId first, if that fails, search globally by fileId
  let file = null;
  if (userId) {
    file = await getFile(userId, params.fileId);
  }

  const canManage = !!file;

  // If not found by userId, search globally by fileId
  if (!file) {
    file = await getFileByFileId(params.fileId);
  }

  if (!file) {
    return redirect("/?message=Page+Not+Found");
  }
  if (file.token) {
    const HashMap = (await import("~/utils/hashmap.server")).default;
    if ((await HashMap.getBoth(file.token)).status === "deleted") return redirect("/deleted");
  }
  return data({ file, canManage });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const formData = await request.formData();
  const { sub } = await requireSessionIdentity(request);
  if (!await getFile(sub, params.fileId)) throw new Response("Not Found", { status: 404 });
  return updateFile(sub, params.fileId, {
    favorite: formData.get("favorite") === "true",
  });
};

// [x] Remove contact page, use edit page
export default function File() {
  const location = useLocation();
  const shownMessageKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const message = search.get("message");
    if (!message) return;
    const key = `${location.pathname}:${location.search}`;
    if (shownMessageKeyRef.current === key) return;
    shownMessageKeyRef.current = key;
    if (message !== "File saved") toast.success(message);
    window.history.replaceState({}, "", location.pathname);
  }, [location]);

  const copyToken = (token: string) => async () => {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy the token. Please copy it manually.");
    }
  };

  const { file, canManage } = useLoaderData<typeof loader>();
  return (
    <div id="contact">
      <div>
        <i
          // alt={`${file.filename} ${file.token} avatar`}
          key={file.magnet}
          // src={file.magnet}
          className={
            (file
              ? fileIconMap[file.type ?? "default"] || "fas fa-file"
              : "fas fa-file-upload") + " fa-2x file-icon"
          }
        ></i>
      </div>

      <div>
        <h1>
          <span
            role="button"
            tabIndex={0}
            onClick={copyToken(file.token ?? "")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void copyToken(file.token ?? "")();
              }
            }}
          >
            {file.filename || file.token ? (
              <>
                {file.filename} #{file.token}
              </>
            ) : (
              <i>No Name</i>
            )}
          </span>{" "}
          {canManage ? <Favorite file={file} /> : null}
        </h1>

        <p aria-hidden="true" />
        {file.size ? <p>Size: {prettyBytes(file.size)}</p> : null}
        {file.notes ? (
          <>
            <p>Notes: {file.notes}</p>
          </>
        ) : null}

        {canManage ? <div>
          <Form action="edit">
            {/* [x]: Make buttons more descriptive (use seed etc.) */}
            <button type="submit">Seed</button>
          </Form>

          <Form
            id="destroy-file-form"
            action="destroy"
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              toast.warning("Are you sure? This record will be deleted.", {
                action: {
                  label: "Yes, delete it!",
                  onClick: () =>
                    (
                      document.getElementById(
                        "destroy-file-form",
                      ) as HTMLFormElement | null
                    )?.submit(),
                },
                cancel: { label: "Cancel", onClick: () => {} },
              });
            }}
          >
            <button type="submit">Delete</button>
          </Form>
        </div> : null}
      </div>
    </div>
  );
}

const Favorite: FunctionComponent<{
  file: Pick<FileRecord, "favorite">;
}> = ({ file: file }) => {
  const fetcher = useFetcher();
  const favorite = fetcher.formData
    ? fetcher.formData.get("favorite") === "true"
    : file.favorite;

  return (
    <fetcher.Form method="post">
      <button
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        name="favorite"
        value={favorite ? "false" : "true"}
      >
        {favorite ? "★" : "☆"}
      </button>
    </fetcher.Form>
  );
};
