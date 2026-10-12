import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { OrderDetail } from "./OrderDetail";
import { Orders } from "./Orders";

export const routes: RouteObject[] = [
  {
    path: "orders",
    element: (
      <Guard perm="orders.read">
        <Orders />
      </Guard>
    ),
  },
  {
    path: "orders/:id",
    element: (
      <Guard perm="orders.read">
        <OrderDetail />
      </Guard>
    ),
  },
];
