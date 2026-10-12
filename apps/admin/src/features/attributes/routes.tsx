import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { Attributes } from "./Attributes";

export const routes: RouteObject[] = [
  {
    path: "attributes",
    element: (
      <Guard perm="products.read">
        <Attributes />
      </Guard>
    ),
  },
];
