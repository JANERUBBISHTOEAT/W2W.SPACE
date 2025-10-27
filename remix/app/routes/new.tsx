import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  return json({
    loggedIn: !!user,
    userId: user?.sub || visitor?.sub,
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
  const { createEmptyFile } = await import("~/utils/data.server");
  const file = await createEmptyFile(sub);
  return redirect(`/files/${file.id}/edit`);
};

export default function New() {
  const { loggedIn, userId } = useLoaderData<typeof loader>();

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        gap: "2rem",
        padding: "2rem",
      }}
    >
      <Form method="post" style={{ flex: 1, display: "contents" }}>
        <input type="hidden" name="type" value="file" />
        <div
          onClick={(e) => e.currentTarget.closest("form")?.requestSubmit()}
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
            background: "#fff",
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
      </Form>

      <Form method="post" style={{ flex: 1, display: "contents" }}>
        <input type="hidden" name="type" value="text" />
        <div
          onClick={(e) => e.currentTarget.closest("form")?.requestSubmit()}
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
            background: "#fff",
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
      </Form>
    </div>
  );
}
