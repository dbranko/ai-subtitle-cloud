import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initToken } from './api';
import { App } from './App';
import './styles.css';

initToken();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
