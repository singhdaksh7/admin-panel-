import type { RouteObject } from "react-router-dom";
import { Guard } from "../../routes";
import { Navigation } from "./Navigation";

export const routes: RouteObject[] = [
  {
    path: "navigation",
    element: (
      <Guard perm="content.read">
        <Navigation />
      </Guard>
    ),
  },
];
