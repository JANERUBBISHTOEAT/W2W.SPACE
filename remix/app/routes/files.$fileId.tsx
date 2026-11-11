import {
  type LoaderFunctionArgs,
  data,
  Form,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import type { FunctionComponent } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { fileIconMap } from "~/utils/constants";
import { putLocalFile, removeLocalFile, useLocalFile } from "~/utils/files.local";
import type { LocalFile } from "~/utils/files.local";
import { prettyBytes } from "~/utils/functions";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  return data({ fileId: params.fileId || "" });
};

export default function File() {
  const location = useLocation();
  const navigate = useNavigate();
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

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy the token. Please copy it manually.");
    }
  };

  const { fileId } = useLoaderData<typeof loader>();
  const { file: personalFile, loading, error } = useLocalFile(fileId);
  if (!personalFile) return <p>{loading ? "Loading…" : error || "This file is not in this browser."}</p>;
  const file = { ...personalFile.share, ...personalFile, filename: personalFile.displayName };
  const token = file.token;
  return (
    <div id="contact">
      <div className="file-type">
        <i className={`${fileIconMap[file.type ?? "default"] || "fas fa-file"} fa-2x file-icon`} aria-hidden="true" />
      </div>

      <div className="file-description">
        <h1 className="file-title">
          {token ? (
            <span
              className="file-title-copy"
              role="button"
              tabIndex={0}
              onClick={() => copyToken(token)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void copyToken(token);
                }
              }}
            >
              <span className="file-name">{file.filename}</span>{" "}
              <span className="file-token">#{token}</span>
            </span>
          ) : (
            <span className="file-name file-title-copy">{file.filename || <i>No Name</i>}</span>
          )}{" "}
          <Favorite file={personalFile} />
        </h1>

        <p className="file-title-spacer" aria-hidden="true" />
        {personalFile.status === "expired" ? <p className="file-message" role="status">This share has expired. Your personal notes are kept in this browser.</p> : null}
        {error ? <p className="file-message" role="alert">{error}</p> : null}
        {typeof file.size === "number" && file.size >= 0 ? <p className="file-size">Size: {prettyBytes(file.size)}</p> : null}
        {file.notes ? (
          <>
            <p className="file-notes">Notes: {file.notes}</p>
          </>
        ) : null}

        <div className="file-actions">
          <Form action="edit">
            <button type="submit">Seed</button>
          </Form>

          <Form
            id="destroy-file-form"
            action="destroy"
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              toast.warning("Remove this record from this browser? The share stays available.", {
                action: {
                  label: "Yes, delete it!",
                  onClick: () => {
                    removeLocalFile(personalFile.id);
                    navigate("/");
                    toast.success("Deleted", {
                      action: { label: "Undo", onClick: () => {
                        putLocalFile(personalFile);
                        navigate(`/files/${personalFile.shareId || personalFile.id}`);
                      } },
                    });
                  },
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

const Favorite: FunctionComponent<{ file: LocalFile }> = ({ file }) => (
  <form className="file-favorite" onSubmit={(event) => {
    event.preventDefault();
    putLocalFile({ ...file, favorite: !file.favorite });
  }}>
    <button aria-label={file.favorite ? "Remove from favorites" : "Add to favorites"} name="favorite" value={file.favorite ? "false" : "true"}>
      {file.favorite ? "★" : "☆"}
    </button>
  </form>
);
