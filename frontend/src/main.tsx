import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { startConnection } from './api';
import { useStore } from './store';
import { world } from './systems/world';
import { cameraApi } from './scene/CameraRig';

// Read-only debug handle for local browser tests and devtools.
(window as unknown as { __office: unknown }).__office = {
  store: useStore,
  world,
  camera: cameraApi,
};

void startConnection();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
