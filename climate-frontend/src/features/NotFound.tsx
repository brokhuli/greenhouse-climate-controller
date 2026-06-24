import { Link } from "react-router-dom";
import { Card } from "../components/Card";

/** On-brand 404 (architecture §3). */
export default function NotFound() {
  return (
    <Card title="Not found">
      <p className="text-fg-muted text-sm">
        That page doesn&rsquo;t exist.{" "}
        <Link to="/" className="text-accent underline">
          Back to the fleet
        </Link>
        .
      </p>
    </Card>
  );
}
