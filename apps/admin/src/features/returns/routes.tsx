import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { ReturnDetail, Returns } from "./Returns";

export const routes: RouteObject[] = [
  {
    path: "returns",
    element: (
      <Guard perm="returns.read">
        <Returns />
      </Guard>
    ),
  },
  {
    path: "returns/:id",
    element: (
      <Guard perm="returns.read">
        <ReturnDetail />
      </Guard>
    ),
  },
];
