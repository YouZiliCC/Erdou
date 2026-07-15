import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme, getTheme } from "./lib/theme.js";
import "./styles.css";

applyTheme(getTheme());

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
