import { useRef, useState } from 'react';
import { Button, TextField } from '@mui/material';

/**
 * Valor para passar adiante (senha provisória, link de acesso). A área de transferência só
 * existe em HTTPS ou localhost; fora disso, o texto fica selecionado para copiar no teclado.
 */
export function CopyField({ label, value }: { label: string; value: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      input.current?.select();
      setState('selected');
    }
  };
  return (
    <div className="copy-field">
      <TextField
        label={label}
        value={value}
        fullWidth
        inputRef={input}
        onFocus={(event) => event.target.select()}
        helperText={state === 'selected' ? 'Selecionado: copie com Ctrl+C.' : undefined}
        slotProps={{ htmlInput: { readOnly: true, className: 'mono' } }}
      />
      <Button variant="outlined" onClick={() => void copy()}>
        {state === 'copied' ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  );
}
