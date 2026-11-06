// No public endpoint can delete an anonymous shared resource.
export const action = () => Response.json({ error: "Remove personal files in this browser" }, { status: 405 });
