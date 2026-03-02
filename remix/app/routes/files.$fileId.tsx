import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useLocation } from "@remix-run/react";
import type { FunctionComponent } from "react";
import { useEffect } from "react";
import Swal from "sweetalert2";
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

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const message = params.get("message");
    if (message) {
      toast.success(message);
      window.history.replaceState({}, "", location.pathname);
    }
  }, [location]);

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
        <h1 onClick={copyToken(file.token)}>
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
            action="destroy"
            method="post"
            onSubmit={async (event) => {
              event.preventDefault();

              const result = await Swal.fire({
                title: "Are you sure?",
                text: "Please confirm you want to delete this record.",
                icon: "warning",
                showCancelButton: true,
                confirmButtonText: "Yes, delete it!",
              });

              if (result.isConfirmed) {
                (event.target as HTMLFormElement).submit();
              }
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
