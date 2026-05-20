import { useNavigate } from "react-router";
import { Button } from "./ui/button";

export function Welcome() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="text-center space-y-8 p-8">
        <h1 className="text-5xl font-bold text-indigo-900">
          Welcome to DarijaGenie
        </h1>
        <Button
          onClick={() => navigate("/chat")}
          size="lg"
          className="text-lg px-8 py-6"
        >
          Start the conversation
        </Button>
      </div>
    </div>
  );
}
