// A removed personal File can only be restored by the browser which removed it.
export const action = () => Response.json({ error: "Restore personal files in this browser" }, { status: 410 });
