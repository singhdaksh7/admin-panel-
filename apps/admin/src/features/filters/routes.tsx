import type { RouteObject } from "react-router-dom";
import { Guard } from "../media/guard";
import { Filters } from "./Filters";

export const routes: RouteObject[] = [
  {
    path: "filters",
    element: (
      <Guard perm="filters.write">
        <Filters />
      </Guard>
    ),
  },
];
