import { Link } from "react-router-dom";
import { useTitle } from "../lib/util";

export default function NotFound() {
  useTitle("Page not found");
  return (
    <section>
      <h1>Page not found</h1>
      <p>Sorry, we could not find what you were looking for.</p>
      <p>
        <Link to="/">Back to the home page</Link>
      </p>
    </section>
  );
}
