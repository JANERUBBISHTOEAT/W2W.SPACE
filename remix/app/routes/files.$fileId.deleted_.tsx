import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import invariant from "tiny-invariant";
import { getVisitorSession, getUserSession } from "~/utils/session.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const userId = user?.sub || visitor?.sub;

  return json({
    fileId: params.fileId,
  });
};

export default function DeletedFile() {
  const { fileId } = useLoaderData<typeof loader>();

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
      <h1 style={{ fontSize: "2rem", color: "#999", margin: 0 }}>
        此文件已被删除
      </h1>
      <p style={{ color: "#999" }}>
        该文件由于超过 30 天未编辑已被系统自动删除
      </p>
    </div>
  );
}
