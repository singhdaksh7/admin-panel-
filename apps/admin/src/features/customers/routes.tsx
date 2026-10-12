import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { CustomerDetail, Customers } from "./Customers";

export const routes: RouteObject[] = [
  {
    path: "customers",
    element: (
      <Guard perm="customers.read">
        <Customers />
      </Guard>
    ),
  },
  {
    path: "customers/:id",
    element: (
      <Guard perm="customers.read">
        <CustomerDetail />
      </Guard>
    ),
  },
];
