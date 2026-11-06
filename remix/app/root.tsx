import "@fortawesome/fontawesome-free/css/all.min.css";
import {
  type LinksFunction,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
  data,
  redirect,
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
} from "react-router";
import { Toaster } from "sonner";
import TransferStatus from "~/components/TransferStatus";
import "sonner/dist/styles.css";
import { useEffect } from "react";
import { randomUUID } from "node:crypto";
import { commitSession, getSession, getUserSession, getVisitorSession } from "~/utils/session.server";
import { getLocalFile, putLocalFile, useLocalFiles } from "~/utils/files.local";
import type { PublicShare } from "~/utils/files.local";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: "/css/app.css" },
  { rel: "stylesheet", href: "/css/all.min.css" },
  { rel: "stylesheet", href: "/css/text-editor.css" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const q = new URL(request.url).searchParams.get("q");
  // Authentication remains optional and independent of shares and local files.
  if (!await getUserSession(request) && !await getVisitorSession(request)) {
    const session = await getSession(request);
    session.set("visitor", { sub: randomUUID() });
    return data({ q }, { headers: { "Set-Cookie": await commitSession(session) } });
  }
  return data({ q });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  if (form.get("type") === "text") {
    const { createEmptyText } = await import("~/utils/text.server");
    const text = await createEmptyText();
    return redirect(`/texts/${text.id}`);
  }
  return redirect("/new");
};

export default function App() {
  const { q } = useLoaderData<typeof loader>();
  const files = useLocalFiles();
  const shareIds = [...new Set(files.flatMap((file) => file.shareId ? [file.shareId] : []))].sort().join(",");
  useEffect(() => {
    let cancelled = false;
    for (const shareId of shareIds.split(",").filter(Boolean)) {
      void fetch(`/api/files?shareId=${encodeURIComponent(shareId)}`)
        .then(async (response) => {
          const result: { share?: PublicShare | null } = await response.json();
          if (cancelled) return;
          const file = getLocalFile(shareId);
          if (!file) return;
          if (response.ok && result.share) putLocalFile({ ...file, share: result.share, status: undefined });
          else if (response.status === 404 || response.status === 410) putLocalFile({ ...file, status: "expired" });
        }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [shareIds]);
  const allItems = files.filter((file) => !q || `${file.displayName} ${file.notes} ${file.share?.token || ""}`.toLowerCase().includes(q.toLowerCase()));
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
        <Toaster richColors position="top-center" />
        <TransferStatus />
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
                {allItems.map((file) => {
                  const lastDate = file.share?.lastAccessedAt;
                  const daysSinceAccess = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : 0;
                  const isExpiring = daysSinceAccess > 25 && daysSinceAccess < 30;
                  const isExpired = file.status === "expired";
                  return (
                    <li key={file.id}>
                      {" "}
                      <NavLink
                        className={({ isActive, isPending }) => isActive ? "active" : isPending ? "pending" : ""}
                        to={`files/${file.shareId || file.id}${file.shareId ? "" : "/edit"}`}
                        style={{ textDecoration: isExpired ? "line-through" : "none" }}
                      >
                        {file.displayName || file.share?.token ? <>{file.displayName} #{file.share?.token || "------"}</> : <i>No Name</i>}{" "}
                        {file.favorite ? <span>★</span> : null}
                        {isExpiring && <i className="fas fa-clock" style={{ color: "#ff6b6b", opacity: 0.6 }} title={`⚠️ Expiring soon (${30 - daysSinceAccess} days left)`} />}
                        {isExpired && <i className="fas fa-trash" style={{ color: "#ccc", opacity: 0.6 }} title="Share expired (30+ days without access)" />}
                        <i className={`fas ${file.direction === "seed" ? "fa-upload" : "fa-download"}`} title={file.direction === "seed" ? "You seeded this file" : "You received this file"} />
                      </NavLink>
                    </li>
                  );
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
