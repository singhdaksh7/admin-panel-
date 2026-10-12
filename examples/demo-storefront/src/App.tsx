import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import Home from "./pages/Home";
import Listing from "./pages/Listing";
import ProductDetail from "./pages/ProductDetail";
import CartPage from "./pages/Cart";
import Checkout from "./pages/Checkout";
import OrderConfirmation from "./pages/OrderConfirmation";
import Account from "./pages/Account";
import { BlogList, BlogPostPage, CmsPage } from "./pages/Content";
import NotFound from "./pages/NotFound";

/** Route table (without a Router so tests can supply a MemoryRouter). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="products" element={<Listing mode="all" />} />
        <Route path="search" element={<Listing mode="search" />} />
        <Route path="category/:slug" element={<Listing mode="category" />} />
        <Route path="collection/:slug" element={<Listing mode="collection" />} />
        <Route path="product/:slug" element={<ProductDetail />} />
        <Route path="cart" element={<CartPage />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="order/:orderNumber" element={<OrderConfirmation />} />
        <Route path="account" element={<Account />} />
        <Route path="blog" element={<BlogList />} />
        <Route path="blog/:slug" element={<BlogPostPage />} />
        <Route path="pages/:slug" element={<CmsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
