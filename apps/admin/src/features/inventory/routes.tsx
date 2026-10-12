import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { Inventory } from "./Inventory";

export const routes: RouteObject[] = [
  {
    path: "inventory",
    element: (
      <Guard perm="inventory.read">
        <Inventory />
      </Guard>
    ),
  },
];
