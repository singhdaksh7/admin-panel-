import type { RouteObject } from "react-router-dom";
import { Guard } from "../../routes";
import { Seo } from "./Seo";

export const routes: RouteObject[] = [
  {
    path: "seo",
    element: (
      <Guard perm="seo.write">
        <Seo />
      </Guard>
    ),
  },
];
