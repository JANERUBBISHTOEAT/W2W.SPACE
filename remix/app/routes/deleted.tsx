export default function Deleted() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: "1rem",
      }}
    >
      <i
        className="fas fa-trash"
        style={{ fontSize: "4rem", color: "#ccc" }}
      ></i>
      <h1 style={{ fontSize: "2rem", color: "#999", margin: 0 }}>Deleted</h1>
      <p style={{ color: "#999" }}>
        This item has been automatically deleted after 30 days without access
      </p>
    </div>
  );
}
