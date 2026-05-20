import { createBrowserRouter } from "react-router";
import { Welcome } from "./components/Welcome";
import { Chat } from "./components/Chat";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Welcome,
  },
  {
    path: "/chat",
    Component: Chat,
  },
]);
