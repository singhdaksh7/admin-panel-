import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Integrations } from "./Integrations";

export const routes: RouteObject[] = [
  {
    path: "integrations",
    element: (
      <Guard perm="integrations.manage">
        <Integrations />
      </Guard>
    ),
  },
];
