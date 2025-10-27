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

  // Check and cleanup expired records
  const { cleanupExpiredRecords, enforceTokenLimit } = await import(
    "~/utils/cleanup.server"
  );
  await Promise.all([cleanupExpiredRecords(), enforceTokenLimit()]);

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

      // Merge and sort by lastEditedAt
      const allItems = [...files, ...texts].sort((a, b) => {
        const dateA = a.lastEditedAt || a.lastAccessedAt || a.createdAt;
        const dateB = b.lastEditedAt || b.lastAccessedAt || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });

      return json({
        files: files,
        texts: texts,
        allItems: allItems,
        q,
        loggedIn: false,
      });
    } else {
      // no session, create with a random id session
      const session = await getSession(request);
      const rid = Math.random().toString(36).substring(2, 9);
      console.log("New visitor session:", rid);
      session.set("visitor", { sub: rid });
      return json(
        { files: [], texts: [], allItems: [], q, loggedIn: false },
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

  // Merge and sort by lastEditedAt
  const allItems = [...files, ...texts].sort((a, b) => {
    const dateA = a.lastEditedAt || a.lastAccessedAt || a.createdAt;
    const dateB = b.lastEditedAt || b.lastAccessedAt || b.createdAt;
    return new Date(dateB).getTime() - new Date(dateA).getTime();
  });

  return json({
    files: files,
    texts: texts,
    allItems: allItems,
    q,
    loggedIn: true,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
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
  const { allItems: allItems, q } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const searching =
    navigation.location &&
    new URLSearchParams(navigation.location.search).has("q");

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
            <h1>Home</h1>
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
            <Form method="get" action="/new">
              <button type="submit" style={{ width: "100%" }}>
                New
              </button>
            </Form>
          </div>
          <nav>
            {allItems && allItems.length > 0 ? (
              <ul>
                {allItems.map((item: any) => {
                  // Determine if it's a file or text
                  const isFile = item.filename !== undefined;
                  const file = isFile ? item : null;
                  const text = !isFile ? item : null;

                  if (file) {
                    // Use lastEditedAt if available, otherwise use lastAccessedAt
                    const lastDate = file.lastEditedAt || file.lastAccessedAt;
                    const daysSinceEdit = lastDate
                      ? Math.floor(
                          (Date.now() - new Date(lastDate).getTime()) /
                            (1000 * 60 * 60 * 24)
                        )
                      : 0;
                    const isExpiring = daysSinceEdit > 25 && daysSinceEdit < 30;
                    const isExpired = file.status === "deleted";

                    return (
                      <li key={file.id}>
                        {" "}
                        <NavLink
                          className={({ isActive, isPending }) =>
                            isActive ? "active" : isPending ? "pending" : ""
                          }
                          to={isExpired ? `/deleted` : `files/${file.id}/edit`}
                          style={{
                            textDecoration: isExpired ? "line-through" : "none",
                          }}
                        >
                          {file.filename || file.token ? (
                            <>
                              {file.filename} #
                              {file.token ? file.token : "------"}
                            </>
                          ) : (
                            <i>No Name</i>
                          )}{" "}
                          {file.favorite ? <span>★</span> : null}
                          {isExpiring && (
                            <i
                              className="fas fa-clock"
                              style={{ color: "#ff6b6b", opacity: 0.6 }}
                              title={`⚠️ Expiring soon (${
                                30 - daysSinceEdit
                              } days left)`}
                            ></i>
                          )}
                          {isExpired && (
                            <i
                              className="fas fa-trash"
                              style={{ color: "#ccc", opacity: 0.6 }}
                              title="🗑️ Deleted (30+ days without access)"
                            ></i>
                          )}
                          <i
                            className={
                              "fas " +
                              (file.owner ? "fa-upload" : "fa-download")
                            }
                            title={
                              file.owner
                                ? "💡You created this file"
                                : "💡You downloaded this file"
                            }
                          ></i>
                        </NavLink>
                      </li>
                    );
                  } else {
                    // Handle text
                    const lastDate = text.lastEditedAt || text.lastAccessedAt;
                    const daysSinceEdit = lastDate
                      ? Math.floor(
                          (Date.now() - new Date(lastDate).getTime()) /
                            (1000 * 60 * 60 * 24)
                        )
                      : 0;
                    const isExpiring = daysSinceEdit > 25 && daysSinceEdit < 30;
                    const isExpired = text.status === "deleted";

                    return (
                      <li key={text.id}>
                        {" "}
                        <NavLink
                          className={({ isActive, isPending }) =>
                            isActive ? "active" : isPending ? "pending" : ""
                          }
                          to={isExpired ? `/deleted` : `texts/${text.id}`}
                          style={{
                            textDecoration: isExpired ? "line-through" : "none",
                          }}
                        >
                          {text.title || text.token ? (
                            <>
                              {text.title} #{text.token ? text.token : "------"}
                            </>
                          ) : (
                            <i>No Name</i>
                          )}{" "}
                          {isExpiring && (
                            <i
                              className="fas fa-clock"
                              style={{ color: "#ff6b6b", opacity: 0.6 }}
                              title={`⚠️ Expiring soon (${
                                30 - daysSinceEdit
                              } days left)`}
                            ></i>
                          )}
                          {isExpired && (
                            <i
                              className="fas fa-trash"
                              style={{ color: "#ccc", opacity: 0.6 }}
                              title="🗑️ Deleted (30+ days without access)"
                            ></i>
                          )}
                          <i
                            className="fas fa-file-code"
                            title="💡Text document"
                          ></i>
                        </NavLink>
                      </li>
                    );
                  }
                })}
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
          <Outlet />
        </div>

        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
