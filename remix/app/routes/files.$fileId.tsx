import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  Form,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
} from "@remix-run/react";
import type { FunctionComponent } from "react";
import { useEffect, useRef } from "react";
import invariant from "tiny-invariant";
import { toast } from "sonner";
import { fileIconMap } from "~/utils/constants";
import type { FileRecord } from "~/utils/data.server";
import { getFile, getFileByFileId, updateFile } from "~/utils/data.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";
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

  // If not found by userId, search globally by fileId
  if (!file) {
    file = await getFileByFileId(params.fileId);
  }

  if (!file) {
    return redirect("/?message=Page+Not+Found");
  }
  return json({ file: file });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const formData = await request.formData();
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  return updateFile(user?.sub || visitor?.sub, params.fileId, {
    favorite: formData.get("favorite") === "true",
  });
};

// [x] Remove contact page, use edit page
export default function File() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const shownMessageKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const message = search.get("message");
    if (!message) return;
    const key = `${location.pathname}:${location.search}`;
    if (shownMessageKeyRef.current === key) return;
    shownMessageKeyRef.current = key;
    const isSaved = message === "File saved";
    if (isSaved) {
      // [x]: replaced by sonner promise
      // toast.success(message, {
      //   action: {
      //     label: "Edit",
      //     onClick: () => navigate(`/files/${params.fileId}/edit`),
      //   },
      // });
    } else {
      toast.success(message);
    }
    window.history.replaceState({}, "", location.pathname);
  }, [location, navigate, params.fileId]);

  const copyToken = (token: string) => async () => {
    await navigator.clipboard.writeText(token);
    toast.success("Token copied to clipboard");
  };

  const { file: file } = useLoaderData<typeof loader>();
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
        <h1 onClick={copyToken(file.token ?? "")}>
          {file.filename || file.token ? (
            <>
              {file.filename} #{file.token}
            </>
          ) : (
            <i>No Name</i>
          )}{" "}
          <Favorite file={file} />
        </h1>

        <p></p>

        {0 && file.notes ? (
          <p>
            Shared with <a href={`/users/${file.notes}`}>{file.notes}</a>
          </p>
        ) : null}
        {file.size ? <p>Size: {prettyBytes(file.size)}</p> : null}
        {file.notes ? (
          <>
            <p>Notes: {file.notes}</p>
          </>
        ) : null}

        <div>
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
        </div>
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
