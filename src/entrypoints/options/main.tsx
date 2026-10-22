import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from '../../ui/OptionsApp';
import '../../ui/styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <OptionsApp />
    </StrictMode>,
  );
}
