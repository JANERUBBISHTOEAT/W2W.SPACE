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
import { useEffect } from "react";
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
      // has session, get files
      console.log("Existing visitor:", visitor.sub);
      const files = await getFiles(visitor.sub, q);
      return json({ files: files, q, loggedIn: false });
    } else {
      // no session, create with a random id session
      const session = await getSession(request);
      const rid = Math.random().toString(36).substring(2, 9);
      console.log("New visitor session:", rid);
      session.set("visitor", { sub: rid });
      return json(
        { files: [], q, loggedIn: false },
        { headers: { "Set-Cookie": await commitSession(session) } }
      );
    }
  }
  console.log("Logged in user:", user.sub);
  const files = await getFiles(user.sub, q);
  return json({ files: files, q, loggedIn: true });
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
  const { files: files, q } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const searching =
    navigation.location &&
    new URLSearchParams(navigation.location.search).has("q");

  useEffect(() => {
    const searchField = document.getElementById("q");
    if (searchField instanceof HTMLInputElement) {
      searchField.value = q || "";
    }
  }, [q]);

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
            <div style={{ display: "flex", gap: "1rem" }}>
              <Form method="post">
                <button 
                  type="submit" 
                  name="type" 
                  value="file"
                  style={{ width: "100%", fontSize: "1.2rem", padding: "1rem" }}
                >
                  📁 New File
                </button>
              </Form>
              <Form method="post">
                <button 
                  type="submit" 
                  name="type" 
                  value="text"
                  style={{ width: "100%", fontSize: "1.2rem", padding: "1rem" }}
                >
                  ✏️ New Text
                </button>
              </Form>
            </div>
          </div>
          <nav>
            {files.length ? (
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
              </ul>
            ) : (
              <p>
                <i>No files</i>
              </p>
            )}
          </nav>
        </div>
        <div
          className={
            navigation.state === "loading" && !searching ? "loading" : ""
          }
          id="detail"
        >
          <Outlet />
        </div>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
