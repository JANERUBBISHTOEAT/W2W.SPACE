import {
  type ActionFunctionArgs,
  redirect,
  Form,
  useNavigate,
} from "react-router";
import { createLocalFile } from "~/utils/files.local";

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const type = formData.get("type") as string;


  if (type === "text") {
    const { createEmptyText } = await import("~/utils/text.server");
    const text = await createEmptyText();
    return redirect(`/texts/${text.id}`);
  }

  return redirect("/new");
};

export default function New() {
  const navigate = useNavigate();

  return (
    <div
      className="new-page"
      style={{
        display: "flex",
        height: "100%",
        gap: "2rem",
        padding: "2rem",
      }}
    >
      <Form method="post" style={{ flex: 1, display: "contents" }} onSubmit={(event) => {
        event.preventDefault();
        const file = createLocalFile();
        navigate(`/files/${file.id}/edit`);
      }}>
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
            color: "inherit",
            textAlign: "inherit",
            boxShadow: "none",
            transform: "none",
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
            color: "inherit",
            textAlign: "inherit",
            boxShadow: "none",
            transform: "none",
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
