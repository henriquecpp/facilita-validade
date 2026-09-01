import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Chip,
  ClickAwayListener,
  CircularProgress,
  MenuItem,
  TextField,
  Typography,
  Tooltip,
  type TextFieldProps,
} from '@mui/material';
import { formatDate, integer, statusLabels } from '../lib/format';
import { APP_NAME } from '../lib/app';
import { daysUntil, expiryText, levelFor, NO_LEVEL } from '../lib/risk';
import type { ExpiryRules } from '../api/store';
import {
  expiryWarning,
  expiryWarningText,
  localToday,
  maskExpiryInput,
  parseExpiryInput,
} from '../lib/expiry-date';
/** Marca do produto: o selo e o nome em duas linhas, que cabem na barra lateral estreita. */
export function Wordmark() {
  return (
    <>
      <span className="brand-mark" aria-hidden="true">
        f.
      </span>
      <span className="wordmark-name">
        {APP_NAME.split(' ').map((word) => (
          <span key={word}>{word}</span>
        ))}
      </span>
    </>
  );
}

export function PageTitle({
  title,
  description,
  action,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="page-title">
      <div className="page-title-text">
        {back && (
          <Link className="back-link" to={back.to} aria-label={`Voltar para ${back.label}`}>
            <Icon name="back" size={16} />
            {back.label}
          </Link>
        )}
        <Typography variant="h4" component="h1">
          {title}
        </Typography>
        {description && (
          <Typography className="page-description" color="text.secondary" component="div">
            {description}
          </Typography>
        )}
      </div>
      {action && <div className="page-actions">{action}</div>}
    </header>
  );
}
export function Loading() {
  return (
    <div className="empty-state" role="status">
      <CircularProgress size={28} />
      <p>Carregando…</p>
    </div>
  );
}
export function ErrorState({ error, retry }: { error: Error | null; retry?: () => void }) {
  return (
    <Alert
      severity="error"
      action={
        retry ? (
          <Button color="inherit" size="small" onClick={retry}>
            Tentar novamente
          </Button>
        ) : undefined
      }
    >
      {error?.message ?? 'Não foi possível carregar os dados.'}
    </Alert>
  );
}
export function Empty({
  title = 'Nada por aqui',
  description,
  action,
  icon = 'stock',
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <Typography variant="h6" component="p">
        {title}
      </Typography>
      {description && <Typography color="text.secondary">{description}</Typography>}
      {action}
    </div>
  );
}
const statusTone: Record<string, 'error' | 'warning' | 'success' | 'info' | 'default'> = {
  EXPIRED: 'error',
  FAILED: 'error',
  HIGH: 'warning',
  OPEN: 'warning',
  COMPLETED_WITH_ISSUES: 'warning',
  CONFIRMED: 'success',
  COMPLETED: 'success',
  TRACKED: 'success',
  ACTIVE: 'success',
  RESOLVED: 'success',
  COUNTING: 'info',
  RECEIVED: 'info',
  PROCESSING: 'info',
};
export function Status({ value }: { value: string }) {
  const [explaining, setExplaining] = useState(false);
  const chip = (
    <Chip
      label={statusLabels[value] ?? value}
      color={statusTone[value] ?? 'default'}
      size="small"
      variant="outlined"
      {...(value === 'TRACKED'
        ? {
            onClick: (event: React.MouseEvent) => {
              event.stopPropagation();
              setExplaining(true);
            },
            'aria-label': 'Controlado: entender esta situação',
          }
        : {})}
    />
  );
  if (value !== 'TRACKED') return chip;
  return (
    <ClickAwayListener onClickAway={() => setExplaining(false)}>
      <Tooltip
        title="Produto com contagem inicial confirmada. Continua controlado mesmo quando o saldo chega a zero; a validade é indicada separadamente."
        open={explaining}
        onOpen={() => setExplaining(true)}
        onClose={() => setExplaining(false)}
        enterTouchDelay={0}
        leaveTouchDelay={5000}
        describeChild
        arrow
      >
        {chip}
      </Tooltip>
    </ClickAwayListener>
  );
}

/** Selo de situação com cor fixa: a cor acompanha o texto, nunca o substitui. */
export function RiskBadge({
  level,
  children,
}: {
  level: 'EXPIRED' | 'HIGH' | 'MEDIUM' | 'OK' | 'NONE';
  children: ReactNode;
}) {
  return <span className={`risk-badge risk-${level.toLowerCase()}`}>{children}</span>;
}

/** Selo na cor do nível de urgência que a loja escolheu. */
export function LevelBadge({
  color,
  name,
  children,
}: {
  color?: string | null;
  name?: string | null;
  children?: ReactNode;
}) {
  return (
    <span
      className="level-badge"
      style={{ '--level': color ?? NO_LEVEL.color } as CSSProperties}
      title={name && children ? name : undefined}
    >
      {children ?? name ?? NO_LEVEL.name}
    </span>
  );
}

/** "Vence em 3 dias" na cor do nível da loja; lote sem saldo aparece como esgotado. */
export function ExpiryBadge({
  date,
  rules,
  quantity,
}: {
  date: string;
  rules: Pick<ExpiryRules, 'today' | 'levels'>;
  quantity?: number;
}) {
  if (quantity === 0) return <RiskBadge level="NONE">Esgotado</RiskBadge>;
  const days = daysUntil(date, rules.today);
  const level = levelFor(rules.levels, days);
  return (
    <LevelBadge color={level?.color} name={level?.name ?? NO_LEVEL.name}>
      {expiryText(days)}
    </LevelBadge>
  );
}

/** Número grande do painel; leva à lista correspondente. Zero não pinta de alerta. */
export function MetricCard({
  label,
  value,
  display,
  help,
  tone = 'neutral',
  icon,
  to,
}: {
  label: string;
  value: number;
  /** O valor já formatado (R$, por exemplo); sem ele, o número inteiro. */
  display?: string;
  help: ReactNode;
  tone?: 'danger' | 'warning' | 'neutral';
  icon?: string;
  to?: string;
}) {
  const body = (
    <>
      <span className="metric-head">
        <span className="metric-label">{label}</span>
        {icon && <Icon name={icon} />}
      </span>
      <strong className="metric-value">{display ?? integer(value)}</strong>
      <span className="metric-help">{help}</span>
    </>
  );
  const className = `metric-card tone-${value > 0 ? tone : 'neutral'}`;
  return to ? (
    <Link className={className} to={to}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Filtros em botões, à vista: um toque troca a lista, sem abrir menu. */
export function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; count?: number | null }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`filter-chip ${option.value === value ? 'active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count != null && <span className="filter-count">{integer(option.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pagination({
  nextCursor,
  onNext,
  onReset,
  hasPrevious,
}: {
  nextCursor: string | null | undefined;
  onNext: (cursor: string) => void;
  onReset: () => void;
  hasPrevious: boolean;
}) {
  if (!hasPrevious && !nextCursor) return null;
  return (
    <div className="pagination">
      {hasPrevious && <Button onClick={onReset}>← Voltar ao início</Button>}
      {nextCursor && <Button onClick={() => onNext(nextCursor)}>Próxima página →</Button>}
    </div>
  );
}

/**
 * Paginação com página anterior e seguinte, "1–25 de 60" e itens por página. O total é
 * opcional: sem ele, mostra só o trecho e a seta para a frente depende de haver mais.
 */
export function PageNav({
  page,
  size,
  sizes,
  shown,
  total,
  hasNext,
  onPrevious,
  onNext,
  onSize,
}: {
  page: number;
  size: number;
  sizes: number[];
  shown: number;
  total?: number | null;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onSize: (size: number) => void;
}) {
  const from = shown ? page * size + 1 : 0;
  const to = page * size + shown;
  // O total vem de outra consulta e pode estar um minuto atrás da lista: nunca menor que ela.
  const count = total == null ? null : Math.max(total, to);
  const pages = count == null ? null : Math.max(1, Math.ceil(count / size));
  return (
    <nav className="page-nav" aria-label="Paginação">
      <TextField
        select
        className="page-size"
        label="Por página"
        value={String(size)}
        fullWidth={false}
        onChange={(event) => onSize(Number(event.target.value))}
      >
        {sizes.map((value) => (
          <MenuItem key={value} value={String(value)}>
            {value}
          </MenuItem>
        ))}
      </TextField>
      <span className="page-range" aria-live="polite">
        {count == null
          ? `${integer(from)}–${integer(to)}`
          : `${integer(from)}–${integer(to)} de ${integer(count)}`}
      </span>
      <div className="page-buttons">
        <Button
          onClick={onPrevious}
          disabled={page === 0}
          startIcon={<Icon name="back" size={16} />}
        >
          Anterior
        </Button>
        {pages != null && (
          <span className="page-count">
            Página {page + 1} de {pages}
          </span>
        )}
        <Button onClick={onNext} disabled={!hasNext} endIcon={<Icon name="chevron" size={16} />}>
          Próxima
        </Button>
      </div>
    </nav>
  );
}

const icons: Record<string, string> = {
  home: 'M4 10.5 12 4l8 6.5V20h-5v-5.5H9V20H4Z',
  calendar: 'M4.5 6h15v14h-15ZM4.5 10h15M8.5 3.5v4M15.5 3.5v4M8 14h2M12 14h2M8 17h2',
  stock: 'M4 7.5 12 4l8 3.5v9L12 20l-8-3.5ZM4 7.5l8 3.5 8-3.5M12 11v9',
  count: 'M9 4.5h6v3H9ZM15 5.5h3.5V20h-13V5.5H9M9 13.5l2 2 4-4.5',
  receipt: 'M4 7.5 12 4l8 3.5v9L12 20l-8-3.5ZM12 9.5v6M9 12.5h6',
  bell: 'M18 10a6 6 0 0 0-12 0c0 5.5-2 7-2 7h16s-2-1.5-2-7M10 20a2 2 0 0 0 4 0',
  issues: 'M12 4 3 19.5h18ZM12 10v4.5M12 17v.5',
  import: 'M12 4v11m-4.5-4.5L12 15l4.5-4.5M4.5 17v3h15v-3',
  audit: 'M4 12a8 8 0 1 0 2.4-5.7M4 4.5V8h3.5M12 8v4.5l3 2',
  users:
    'M15.5 20v-1.5a3.5 3.5 0 0 0-3.5-3.5H7a3.5 3.5 0 0 0-3.5 3.5V20M9.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M17 4.8a3.5 3.5 0 0 1 0 6.4M20.5 20v-1.5a3.5 3.5 0 0 0-2.5-3.3',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  chevron: 'm9.5 6 6 6-6 6',
  back: 'M19 12H5.5M11 6l-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5 10 17l9-10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  logout: 'M14 4.5h4.5v15H14M9.5 8 5.5 12l4 4M5.5 12H15',
  lock: 'M6.5 11h11v9h-11ZM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  barcode: 'M4 6v12M7 6v12M10.5 6v12M13 6v12M16.5 6v12M20 6v12',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  trash: 'M5 7h14M10 4.5h4M7 7l.8 12.5h8.4L17 7M10.5 10.5v6M13.5 10.5v6',
  edit: 'M5 19h3.5L19 8.5 15.5 5 5 15.5ZM13.5 7l3.5 3.5',
  minus: 'M5 12h14',
  more: 'M12 6.5v.01M12 12v.01M12 17.5v.01',
  list: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  money: 'M4 7h16v10H4ZM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M7 10v.01M17 14v.01',
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icons[name] ?? icons.stock} />
    </svg>
  );
}

/**
 * Validade digitável: aceita só números (12042026), qualquer separador e ano com dois dígitos.
 * Ao sair do campo, a data válida é exibida por extenso (12/04/2026). Calendário não é exigido.
 */
export function ExpiryDateField({
  value,
  onChange,
  error,
  helperText,
  onBlur,
  ...props
}: Omit<TextFieldProps, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const iso = parseExpiryInput(value);
  const warning = iso ? expiryWarning(iso, localToday()) : null;
  return (
    <TextField
      {...props}
      value={value}
      placeholder="DD/MM/AAAA"
      onChange={(event) => onChange(maskExpiryInput(event.target.value))}
      onBlur={(event) => {
        if (iso) onChange(formatDate(iso));
        onBlur?.(event);
      }}
      error={error}
      helperText={
        helperText ?? (warning ? expiryWarningText[warning] : 'Digite só os números: 12042026.')
      }
      slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 10, autoComplete: 'off' } }}
    />
  );
}
