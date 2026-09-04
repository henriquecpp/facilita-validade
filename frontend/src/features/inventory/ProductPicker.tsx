import { useEffect, useState } from 'react';
import { Alert, Button, CircularProgress, InputAdornment, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { api, queryString } from '../../shared/api/client';
import { useApiQuery } from '../../shared/api/hooks';
import { useDebounced } from '../../shared/api/store';
import type { Page, Product } from '../../shared/api/types';
import { invalidEan13 } from '../../shared/lib/barcode';
import { Icon } from '../../shared/ui/components';
import { useAuth } from '../auth/AuthProvider';

/**
 * EAN-13 ou GTIN-14 digitado: um código completo, consultado sem esperar o Enter. Um número mais
 * curto pode ser o começo de um código: ele busca na lista (nome e códigos) até o Enter, que o
 * leitor manda no fim de toda leitura e que consulta o código de qualquer tamanho.
 */
const COMPLETE = /^\d{13,14}$/;
const SHOWN = 8;

/**
 * Um campo só para achar o produto: parte do nome ou o código de barras. O leitor USB
 * "digita" o código e tecla Enter, e o produto já fica escolhido.
 */
export function ProductPicker({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  value: Product | null;
  onChange: (product: Product | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [scan, setScan] = useState('');
  const [changing, setChanging] = useState(false);
  const typed = useDebounced(text.trim(), 300);
  const code = scan || (COMPLETE.test(typed) ? typed : '');
  // EAN-13 com o último dígito errado: lido ou digitado errado, nem vale consultar.
  const invalid = !!code && invalidEan13(code);
  const term = !code && typed.length >= 2 ? typed : '';
  const byName = useApiQuery<Page<Product>>(`/products${queryString({ search: term })}`, {
    enabled: !!term && !value,
  });
  const byCode = useQuery({
    queryKey: [session?.store.id, 'barcode', code],
    queryFn: () => api<Product>(`/products/by-barcode/${encodeURIComponent(code)}`),
    enabled: !!code && !invalid && !value,
    retry: false,
  });
  const found = byCode.data;
  useEffect(() => {
    if (!scan || !found || value) return;
    setScan('');
    setText('');
    onChange(found);
  }, [scan, found, value, onChange]);

  if (value)
    return (
      <div className="picked-product">
        <span className="picked-icon">
          <Icon name="check" />
        </span>
        <span className="picked-text">
          <strong>{value.description}</strong>
          <small>
            {value.barcodes?.length ? value.barcodes.join(' · ') : 'Produto escolhido'}
            {!value.active && ' · inativo no catálogo'}
          </small>
        </span>
        <Button
          size="small"
          disabled={disabled}
          onClick={() => {
            setChanging(true);
            onChange(null);
          }}
        >
          Trocar
        </Button>
      </div>
    );

  const results = code ? (found ? [found] : []) : term ? (byName.data?.items ?? []) : [];
  const searching = (!!code && byCode.isFetching) || (!!term && byName.isFetching);
  const pick = (product: Product) => {
    setText('');
    setScan('');
    onChange(product);
  };
  return (
    <div className="product-picker">
      <TextField
        label="Produto"
        placeholder="Nome ou código de barras"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus || changing}
        autoComplete="off"
        onChange={(event) => {
          setText(event.target.value);
          setScan('');
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const typedNow = text.trim();
          if (/^\d+$/.test(typedNow)) setScan(typedNow);
          else if (results.length === 1) pick(results[0]!);
        }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <Icon name="search" size={18} />
              </InputAdornment>
            ),
            endAdornment: searching ? (
              <InputAdornment position="end">
                <CircularProgress size={16} />
              </InputAdornment>
            ) : undefined,
          },
        }}
      />
      {invalid && (
        <Alert severity="warning">
          O código {code} não é um EAN-13 válido: o último dígito não confere com os anteriores.
          Confira o número.
        </Alert>
      )}
      {code && !invalid && byCode.isError && (
        <Alert severity="warning">
          Nenhum produto com o código {code}. Confira o número; produto cadastrado há pouco no
          sistema da loja pode levar alguns minutos para aparecer.
        </Alert>
      )}
      {term && byName.isError && (
        <Alert severity="error">Não foi possível buscar no catálogo. Tente novamente.</Alert>
      )}
      {term && byName.data && !results.length && (
        <p className="picker-note">Nenhum produto com “{term}” na descrição.</p>
      )}
      {results.length > 0 && (
        <ul className="picker-results" aria-label="Produtos encontrados">
          {results.slice(0, SHOWN).map((product) => (
            <li key={product.id}>
              <button type="button" disabled={disabled} onClick={() => pick(product)}>
                <span className="product-name">{product.description}</span>
                <span className="muted">
                  {product.barcodes?.[0] ?? 'Sem código de barras'}
                  {!product.active && ' · inativo'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length > SHOWN && (
        <p className="picker-note">
          Mostrando {SHOWN} de {results.length}
          {byName.data?.nextCursor ? '+' : ''}. Digite mais do nome para encontrar o produto.
        </p>
      )}
    </div>
  );
}
