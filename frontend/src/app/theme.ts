import { createTheme } from '@mui/material/styles';
const phone = '@media (max-width: 600px)';
// As mesmas cores de styles.css (:root): mudar uma pede mudar a outra.
export const theme = createTheme({
  palette: {
    primary: { main: '#245d4b', dark: '#173f36', light: '#e9f2ed', contrastText: '#ffffff' },
    secondary: { main: '#b46b32' },
    background: { default: '#f4f6f3', paper: '#ffffff' },
    text: { primary: '#1c2f29', secondary: '#56655e' },
    error: { main: '#b42318' },
    warning: { main: '#b54708' },
    success: { main: '#1f7a55' },
    info: { main: '#285e8e' },
    divider: '#e2e8e1',
  },
  typography: {
    fontFamily: '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif',
    h4: { fontSize: '1.625rem', fontWeight: 700, letterSpacing: '-0.3px', lineHeight: 1.25 },
    h5: { fontSize: '1.25rem', fontWeight: 650, lineHeight: 1.3 },
    h6: { fontSize: '1.0625rem', fontWeight: 650, lineHeight: 1.35 },
    button: { textTransform: 'none', fontWeight: 600, fontSize: '0.9rem' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 8,
          whiteSpace: 'nowrap',
          [phone]: {
            minHeight: 44,
            maxWidth: '100%',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            lineHeight: 1.4,
            textAlign: 'center',
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: { root: { [phone]: { minWidth: 44, minHeight: 44 } } },
    },
    MuiTextField: {
      defaultProps: { fullWidth: true, variant: 'outlined', size: 'small' },
      styleOverrides: { root: { [phone]: { minWidth: 0 } } },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { backgroundColor: '#ffffff', [phone]: { minWidth: 0, minHeight: 44 } },
        input: { [phone]: { minWidth: 0, fontSize: 16 } },
      },
    },
    MuiFormControlLabel: {
      styleOverrides: {
        root: {
          [phone]: {
            minWidth: 0,
            minHeight: 44,
            maxWidth: '100%',
            marginLeft: 0,
            marginRight: 0,
            alignItems: 'flex-start',
          },
        },
        label: { [phone]: { minWidth: 0, overflowWrap: 'anywhere', paddingBlock: '9px' } },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          background: '#f7f9f6',
          color: '#56655e',
          fontWeight: 600,
          fontSize: 13,
          whiteSpace: 'nowrap',
        },
        root: { borderColor: '#edf1ec', padding: '12px 16px', fontSize: 14 },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          fontSize: 12.5,
          [phone]: {
            maxWidth: '100%',
            height: 'auto',
            minHeight: 24,
            '&.MuiChip-clickable': { minHeight: 44 },
          },
        },
        label: { [phone]: { whiteSpace: 'normal', overflowWrap: 'anywhere', paddingBlock: '3px' } },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10, [phone]: { flexWrap: 'wrap' } },
        message: {
          lineHeight: 1.55,
          [phone]: { minWidth: 0, flex: '1 1 160px', overflowWrap: 'anywhere' },
        },
        action: { [phone]: { maxWidth: '100%', marginLeft: 'auto', paddingTop: 0 } },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 14,
          [phone]: {
            '&:not(.MuiDialog-paperFullScreen)': {
              margin: 16,
              width: 'calc(100% - 32px)',
              maxWidth: 'calc(100% - 32px)',
              maxHeight: 'calc(100% - 32px)',
              minWidth: 0,
              overflowWrap: 'anywhere',
            },
          },
          '@media (max-width: 360px)': {
            '&:not(.MuiDialog-paperFullScreen)': {
              margin: 8,
              width: 'calc(100% - 16px)',
              maxWidth: 'calc(100% - 16px)',
              maxHeight: 'calc(100% - 16px)',
            },
          },
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontWeight: 700,
          fontSize: '1.15rem',
          [phone]: { padding: 16, overflowWrap: 'anywhere' },
        },
      },
    },
    MuiDialogContent: {
      styleOverrides: { root: { [phone]: { minWidth: 0, padding: 16 } } },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          [phone]: {
            flexWrap: 'wrap',
            gap: 8,
            padding: 16,
            '& > :not(style) ~ :not(style)': { marginLeft: 0 },
          },
        },
      },
    },
    MuiTooltip: { styleOverrides: { tooltip: { fontSize: 13 } } },
  },
});
