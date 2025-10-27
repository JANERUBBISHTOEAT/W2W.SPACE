import "@fortawesome/fontawesome-free/css/all.min.css";
import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/node";
import { ActionFunctionArgs, json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import "sweetalert2/dist/sweetalert2.min.css";
import "toastr/build/toastr.min.css";
import { createEmptyFile, getFiles } from "~/utils/data.server";
import {
  commitSession,
  getSession,
  getUserSession,
  getVisitorSession,
} from "./utils/session.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: "/css/app.css" },
  { rel: "stylesheet", href: "/css/all.min.css" },
  { rel: "stylesheet", href: "/css/toastr.min.css" },
  { rel: "stylesheet", href: "/css/text-editor.css" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // [x]: Add user authentication
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  const user = await getUserSession(request);
  if (!user) {
    // visitor, check if has session
    const session = await getSession(request);
    console.log("Session:", session.data);
    const visitor = await getVisitorSession(request);
    console.log("Visitor:", visitor);
    if (visitor) {
      // has session, get files and texts
      console.log("Existing visitor:", visitor.sub);
      const { getTexts } = await import("~/utils/text.server");
      const [files, texts] = await Promise.all([
        getFiles(visitor.sub, q),
        getTexts(visitor.sub, q),
      ]);
      return json({ files: files, texts: texts, q, loggedIn: false });
    } else {
      // no session, create with a random id session
      const session = await getSession(request);
      const rid = Math.random().toString(36).substring(2, 9);
      console.log("New visitor session:", rid);
      session.set("visitor", { sub: rid });
      return json(
        { files: [], texts: [], q, loggedIn: false },
        { headers: { "Set-Cookie": await commitSession(session) } }
      );
    }
  }
  console.log("Logged in user:", user.sub);
  const { getTexts } = await import("~/utils/text.server");
  const [files, texts] = await Promise.all([
    getFiles(user.sub, q),
    getTexts(user.sub, q),
  ]);
  return json({ files: files, texts: texts, q, loggedIn: true });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const type = formData.get("type") as string;

  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const sub = user?.sub || visitor?.sub;

  if (type === "text") {
    const { createEmptyText } = await import("~/utils/text.server");
    const text = await createEmptyText(sub);
    return redirect(`/texts/${text.id}`);
  }

  // Default to file
  const file = await createEmptyFile(sub);
  return redirect(`/files/${file.id}/edit`);
};

export default function App() {
  const { files: files, texts: texts, q } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [showNewOptions, setShowNewOptions] = useState(false);
  const searching =
    navigation.location &&
    new URLSearchParams(navigation.location.search).has("q");

  useEffect(() => {
    const searchField = document.getElementById("q");
    if (searchField instanceof HTMLInputElement) {
      searchField.value = q || "";
    }
  }, [q]);

  // Close new options when navigation starts
  useEffect(() => {
    if (showNewOptions && navigation.state === "loading") {
      setShowNewOptions(false);
    }
  }, [navigation.state, showNewOptions]);

  // Add ESC key listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showNewOptions) {
        setShowNewOptions(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showNewOptions]);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {/* <script type="module">
          import WebTorrent from 'webtorrent.min.js'
        </script> */}
        {/* ! HTML embed: import no complain, but module not found anywhere (waited) */}
        <div id="sidebar">
          <Link to=".">
            <h1>Receive Files</h1>
          </Link>
          <div>
            <Form
              id="search-form"
              onChange={(event) => {
                const isFirstSearch = q === null;
                submit(event.currentTarget, {
                  replace: !isFirstSearch,
                });
              }}
              role="search"
            >
              <input
                id="q"
                className={searching ? "loading" : ""}
                defaultValue={q || ""}
                aria-label="Search files"
                placeholder="Search"
                type="search"
                name="q"
              />
              <div id="search-spinner" hidden={!searching} aria-hidden />
            </Form>
            <Form method="post">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setShowNewOptions(true);
                }}
                style={{ width: "100%" }}
              >
                New
              </button>
            </Form>
          </div>
          <nav>
            {files.length > 0 || texts.length > 0 ? (
              <ul>
                {files.map((file) => (
                  <li key={file.id}>
                    {" "}
                    <NavLink
                      className={({ isActive, isPending }) =>
                        isActive ? "active" : isPending ? "pending" : ""
                      }
                      to={`files/${file.id}`}
                    >
                      {file.filename || file.token ? (
                        <>
                          {file.filename} #{file.token ? file.token : "------"}
                        </>
                      ) : (
                        <i>No Name</i>
                      )}{" "}
                      {file.favorite ? <span>★</span> : null}
                      <i
                        className={
                          "fas " + (file.owner ? "fa-upload" : "fa-download")
                        }
                        title={
                          file.owner
                            ? "💡You created this file"
                            : "💡You downloaded this file"
                        }
                      ></i>
                    </NavLink>
                  </li>
                ))}
                {texts.map((text) => (
                  <li key={text.id}>
                    {" "}
                    <NavLink
                      className={({ isActive, isPending }) =>
                        isActive ? "active" : isPending ? "pending" : ""
                      }
                      to={`texts/${text.id}`}
                    >
                      {text.title || text.token ? (
                        <>
                          {text.title} #{text.token ? text.token : "------"}
                        </>
                      ) : (
                        <i>No Name</i>
                      )}{" "}
                      <i
                        className="fas fa-file-code"
                        title="💡Text document"
                      ></i>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                <i>No files or texts</i>
              </p>
            )}
          </nav>
        </div>
        <div
          className={
            navigation.state === "loading" && !searching ? "loading" : ""
          }
          id="detail"
          style={{ position: "relative" }}
        >
          {showNewOptions ? (
            <div
              style={{
                display: "flex",
                height: "100%",
                gap: "2rem",
                padding: "2rem",
                position: "relative",
              }}
            >
              {/* Close button hidden for now */}
              {/* <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowNewOptions(false);
                }}
                style={{
                  position: "absolute",
                  top: "0.5rem",
                  right: "0.5rem",
                  padding: "0.4rem 0.8rem",
                  fontSize: "1.5rem",
                  cursor: "pointer",
                  border: "none",
                  borderRadius: "50%",
                  backgroundColor: "rgba(0,0,0,0.1)",
                  color: "#666",
                  fontWeight: "bold",
                  transition: "all 0.2s",
                  zIndex: 10,
                  width: "2rem",
                  height: "2rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: "1",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.2)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.1)";
                }}
              >
                ✕
              </button> */}
              <div
                onClick={() => {
                  setShowNewOptions(false);
                  submit({ type: "file" }, { method: "post" });
                }}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "4px solid #3992ff",
                  borderRadius: "1rem",
                  cursor: "pointer",
                  padding: "2rem",
                  fontSize: "2rem",
                  fontWeight: "bold",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f0f7ff";
                  e.currentTarget.style.transform = "scale(1.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                <div style={{ fontSize: "5rem", marginBottom: "1rem" }}>📁</div>
                <div>New File</div>
              </div>
              <div
                onClick={() => {
                  setShowNewOptions(false);
                  submit({ type: "text" }, { method: "post" });
                }}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "4px solid #3992ff",
                  borderRadius: "1rem",
                  cursor: "pointer",
                  padding: "2rem",
                  fontSize: "2rem",
                  fontWeight: "bold",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f0f7ff";
                  e.currentTarget.style.transform = "scale(1.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                <div style={{ fontSize: "5rem", marginBottom: "1rem" }}>✏️</div>
                <div>New Text</div>
              </div>
            </div>
          ) : (
            <Outlet />
          )}
        </div>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
