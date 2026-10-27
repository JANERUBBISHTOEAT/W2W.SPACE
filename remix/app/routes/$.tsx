import { redirect } from "react-router";

// Match any unknown page and redirect
export const loader = async () => {
  return redirect("/?message=Page+Not+Found");
};
