import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Button, Drawer, useMediaQuery } from '@mui/material';
import { useLocation } from 'react-router-dom';

/** O mesmo limite do layout CSS: em 900px o menu já fica recolhido. */
export function useMobileSidebar() {
  const mobile = useMediaQuery('(max-width: 900px)', { noSsr: true });
  const location = useLocation();
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    setRequested(false);
  }, [mobile, location.key, location.pathname, location.search, location.hash]);
  return {
    mobile,
    open: mobile && requested,
    show: (event: MouseEvent<HTMLButtonElement>) => {
      // O Modal restaura este foco ao fechar, inclusive em navegadores que não focam ao tocar.
      event.currentTarget.focus();
      setRequested(true);
    },
    close: () => setRequested(false),
  };
}

/** O Modal do MUI cuida de foco, Escape, backdrop, leitores de tela e rolagem do fundo. */
export function MobileSidebar({
  id,
  label,
  open,
  close,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  return (
    <Drawer
      variant="temporary"
      anchor="left"
      open={open}
      onClose={close}
      ModalProps={{ keepMounted: false }}
      slotProps={{
        transition: {
          onEntered: (node: HTMLElement) => {
            // O portal pode montar antes de o botão aceitar foco no navegador. Depois da
            // entrada, troca o foco do Paper por Fechar sem interromper quem já navegou no menu.
            const active = node.ownerDocument.activeElement;
            if (active === node || !node.contains(active)) {
              closeButton.current?.focus({ preventScroll: true });
            }
          },
        },
        paper: {
          id,
          className: 'mobile-sidebar',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': label,
          sx: {
            width: 'min(300px, calc(100vw - 48px))',
            padding: '16px 14px',
            boxSizing: 'border-box',
            backgroundColor: 'var(--surface)',
            color: 'var(--text)',
          },
          onClick: (event: MouseEvent<HTMLElement>) => {
            // Também fecha quando o link aponta para a rota atual, sem depender de um rerender.
            if (event.target instanceof Element && event.target.closest('a[href]')) close();
          },
        },
      }}
    >
      <div className="mobile-sidebar-heading">
        <strong>Menu</strong>
        <Button
          ref={closeButton}
          autoFocus
          color="inherit"
          onClick={close}
          aria-label="Fechar menu"
        >
          Fechar
        </Button>
      </div>
      {children}
    </Drawer>
  );
}
