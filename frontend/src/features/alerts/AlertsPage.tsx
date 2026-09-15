import { useState, type CSSProperties } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Alert, Button } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { api, queryString } from '../../shared/api/client';
import { useApiQuery, useBusinessMutation } from '../../shared/api/hooks';
import { useExpiryRules } from '../../shared/api/store';
import type { Notification, Page } from '../../shared/api/types';
import {
  Empty,
  ErrorState,
  FilterChips,
  Icon,
  LevelBadge,
  Loading,
  PageTitle,
  Pagination,
  RiskBadge,
} from '../../shared/ui/components';
import { formatDate, units } from '../../shared/lib/format';
import { daysUntil, expiryText } from '../../shared/lib/risk';
import { randomUuid } from '../../shared/lib/uuid';
import { useAuth } from '../auth/AuthProvider';

/** Filtro: um nível da loja (id) ou os lotes zerados pelas vendas. */
const DEPLETED = 'DEPLETED';

function NotificationRow({ notification, today }: { notification: Notification; today: string }) {
  const read = useBusinessMutation<Record<string, never>>(`/notifications/${notification.id}/read`);
  const depleted = notification.type === 'DEPLETED';
  // O prazo é recalculado aqui: a mensagem gravada envelhece de um dia para o outro.
  const days = notification.expiresOn ? daysUntil(notification.expiresOn, today) : null;
  const detail = depleted
    ? 'O saldo estimado deste lote acabou. Confira na gôndola se ainda há unidades.'
    : [
        notification.quantity != null && `${units(notification.quantity)} na loja`,
        days != null && `${expiryText(days).toLowerCase()} (${formatDate(notification.expiresOn)})`,
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <article
      className={`notification-row ${depleted ? 'level-info' : ''} ${notification.readAt ? '' : 'unread'}`}
      style={
        !depleted && notification.levelColor
          ? ({ '--level': notification.levelColor } as CSSProperties)
          : undefined
      }
    >
      <div className="notification-body">
        <h3>
          {!notification.readAt && <span className="unread-dot" title="Não lido" aria-hidden />}
          {notification.productName ?? notification.title}
        </h3>
        <p>{detail || notification.message}</p>
        <div className="notification-meta">
          {depleted ? (
            <RiskBadge level="NONE">Lote baixado</RiskBadge>
          ) : (
            <LevelBadge color={notification.levelColor} name={notification.levelName} />
          )}
          {depleted && notification.expiresOn && (
            <span>Validade {formatDate(notification.expiresOn)}</span>
          )}
          <span>Aviso de {formatDate(notification.createdAt)}</span>
        </div>
        {read.error && <ErrorState error={read.error} />}
      </div>
      <div className="inline-actions">
        {notification.productId && (
          <Button component={Link} to={`/products/${notification.productId}`} size="small">
            Ver produto
          </Button>
        )}
        {!notification.readAt && (
          <Button size="small" disabled={read.isPending} onClick={() => read.mutate({})}>
            Marcar como lido
          </Button>
        )}
      </div>
    </article>
  );
}

export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const { session } = useAuth();
  const cache = useQueryClient();
  const level = params.get('filtro') ?? '';
  const cursor = params.get('cursor') ?? '';
  const rules = useExpiryRules();
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState('');
  const query = useApiQuery<Page<Notification>>(
    `/notifications${queryString({
      type: level === DEPLETED ? DEPLETED : undefined,
      levelId: level && level !== DEPLETED ? level : undefined,
      cursor,
      limit: 50,
    })}`,
    { poll: true },
  );
  const unread = query.data?.items.filter((item) => !item.readAt) ?? [];
  async function markAll() {
    setMarking(true);
    setMarkError('');
    try {
      // Um por vez, cada um com sua chave: repetir depois de uma falha não duplica nada.
      for (const item of unread)
        await api(`/notifications/${item.id}/read`, {
          method: 'POST',
          body: '{}',
          headers: { 'Idempotency-Key': randomUuid() },
        });
    } catch (error) {
      setMarkError(error instanceof Error ? error.message : 'Não foi possível marcar todos.');
    } finally {
      setMarking(false);
      void cache.invalidateQueries({ queryKey: [session?.store.id] });
    }
  }
  return (
    <>
      <PageTitle
        title="Alertas"
        description="Avisos dos níveis de urgência que avisam e dos lotes que as vendas zeraram. Marcar como lido não altera o estoque."
        action={
          unread.length > 1 ? (
            <Button variant="outlined" disabled={marking} onClick={() => void markAll()}>
              {marking ? 'Marcando…' : `Marcar ${unread.length} como lidos`}
            </Button>
          ) : undefined
        }
      />
      {markError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {markError}
        </Alert>
      )}
      <section className="surface table-surface">
        <div className="table-toolbar">
          <FilterChips
            label="Tipo de alerta"
            value={level}
            onChange={(next) => setParams(next ? { filtro: next } : {})}
            options={[
              { value: '', label: 'Todos' },
              ...rules.levels
                .filter((item) => item.notify)
                .map((item) => ({ value: item.id, label: item.name })),
              { value: DEPLETED, label: 'Lotes baixados' },
            ]}
          />
          <Button
            className="toolbar-end"
            startIcon={<Icon name="refresh" size={18} />}
            onClick={() => void query.refetch()}
          >
            Atualizar
          </Button>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : !query.data.items.length ? (
          <Empty
            icon="bell"
            title={level ? 'Nenhum alerta deste tipo' : 'Nenhum alerta no momento'}
            description="Os alertas aparecem quando um lote entra num nível que avisa, vence ou é zerado pelas vendas."
          />
        ) : (
          <>
            {query.data.items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                today={rules.today}
              />
            ))}
            <Pagination
              nextCursor={query.data.nextCursor}
              hasPrevious={!!cursor}
              onNext={(next) =>
                setParams(level ? { filtro: level, cursor: next } : { cursor: next })
              }
              onReset={() => setParams(level ? { filtro: level } : {})}
            />
          </>
        )}
      </section>
    </>
  );
}
