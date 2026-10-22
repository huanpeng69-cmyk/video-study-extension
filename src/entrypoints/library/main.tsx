import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryApp } from '../../ui/LibraryApp';
import '../../ui/styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <LibraryApp />
    </StrictMode>,
  );
}
