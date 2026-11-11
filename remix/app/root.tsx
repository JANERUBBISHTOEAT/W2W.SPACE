import "@fortawesome/fontawesome-free/css/all.min.css";
import {
  type LinksFunction,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
  data,
  redirect,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useNavigation,
} from "react-router";
import { Toaster } from "sonner";
import TransferStatus from "~/components/TransferStatus";
import Sidebar from "~/components/Sidebar";
import appStyles from "~/styles/app.css?url";
import textEditorStyles from "~/styles/text-editor.css?url";
import sidebarStyles from "~/styles/sidebar.css?url";
import "sonner/dist/styles.css";
import { useEffect } from "react";
import { randomUUID } from "node:crypto";
import { commitSession, getSession, getUserSession, getVisitorSession } from "~/utils/session.server";
import { getLocalFile, putLocalFile, useLocalFiles } from "~/utils/files.local";
import type { PublicShare } from "~/utils/files.local";
import { useLocalTexts } from "~/utils/texts.local";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: appStyles },
  { rel: "stylesheet", href: textEditorStyles },
  { rel: "stylesheet", href: sidebarStyles },
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
  const texts = useLocalTexts();
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
  const query = q?.toLowerCase();
  const allItems = [
    ...files.filter((file) => !query || `${file.displayName} ${file.notes} ${file.share?.token || ""}`.toLowerCase().includes(query))
      .map((file) => ({ kind: "file" as const, record: file })),
    ...texts.filter((text) => !query || `${text.title} ${text.token}`.toLowerCase().includes(query))
      .map((text) => ({ kind: "text" as const, record: text })),
  ].sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
  const navigation = useNavigation();
  const searching =
    navigation.location &&
    new URLSearchParams(navigation.location.search).has("q");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body>
        <Toaster richColors position="top-center" />
        <TransferStatus />
        <Sidebar items={allItems} q={q} searching={Boolean(searching)} />
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
