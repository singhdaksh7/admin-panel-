import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { Collections } from "./Collections";

export const routes: RouteObject[] = [
  {
    path: "collections",
    element: (
      <Guard perm="products.read">
        <Collections />
      </Guard>
    ),
  },
];
