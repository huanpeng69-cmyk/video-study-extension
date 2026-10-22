import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupApp } from '../../ui/PopupApp';
import '../../ui/styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <PopupApp />
    </StrictMode>,
  );
}
