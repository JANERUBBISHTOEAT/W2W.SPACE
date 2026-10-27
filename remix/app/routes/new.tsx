import {
  type ActionFunctionArgs,
  redirect,
  Form,
} from "react-router";
import { requireSessionIdentity } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const type = formData.get("type") as string;

  const { sub } = await requireSessionIdentity(request);

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
        <button
          type="submit"
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
        </button>
      </Form>

      <Form method="post" style={{ flex: 1, display: "contents" }}>
        <input type="hidden" name="type" value="text" />
        <button
          type="submit"
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
        </button>
      </Form>
    </div>
  );
}
