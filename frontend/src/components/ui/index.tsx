import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type CSSProperties,
    type InputHTMLAttributes,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import s from './ui.module.scss';

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(' ');

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'link';
    size?: 'large' | 'small';
    block?: boolean;
    loading?: boolean;
}

export function Button({
    variant = 'primary',
    size = 'large',
    block,
    loading,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
}: ButtonProps) {
    return (
        <button
            type={type}
            className={cx(
                s.button,
                s[variant],
                size === 'small' && s.small,
                block && s.block,
                className
            )}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            {...rest}
        >
            {loading ? <span className={s.spinner} aria-hidden="true" /> : null}
            {children}
        </button>
    );
}

export function Chip({
    tone = 'neutral',
    icon,
    children,
    label,
}: {
    tone?: 'neutral' | 'sun' | 'fire' | 'brand';
    icon?: ReactNode;
    children: ReactNode;
    label?: string;
}) {
    const toneClass = { neutral: undefined, sun: s.chipSun, fire: s.chipFire, brand: s.chipBrand }[
        tone
    ];
    return (
        <span className={cx(s.chip, toneClass)} aria-label={label}>
            {icon}
            {children}
        </span>
    );
}

export function Card({
    children,
    muted,
    onClick,
    className,
    label,
}: {
    children: ReactNode;
    muted?: boolean;
    onClick?: () => void;
    className?: string;
    label?: string;
}) {
    if (onClick) {
        return (
            <button
                type="button"
                className={cx(s.card, muted && s.cardMuted, s.cardInteractive, className)}
                onClick={onClick}
                aria-label={label}
            >
                {children}
            </button>
        );
    }
    return (
        <section className={cx(s.card, muted && s.cardMuted, className)} aria-label={label}>
            {children}
        </section>
    );
}

function useOverlay(open: boolean, onClose: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const previous = document.activeElement as HTMLElement | null;
        const node = ref.current;
        node?.querySelector<HTMLElement>(
            'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
        )?.focus();
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (e.key !== 'Tab' || !node) return;
            const focusable = [
                ...node.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
                ),
            ];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = overflow;
            previous?.focus?.();
        };
    }, [open, onClose]);
    return ref;
}

interface OverlayProps {
    open: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
}

function Overlay({
    open,
    onClose,
    title,
    children,
    kind,
}: OverlayProps & { kind: 'sheet' | 'dialog' }) {
    const ref = useOverlay(open, onClose);
    const titleId = useId();
    if (!open) return null;
    return createPortal(
        <div
            className={cx(s.scrim, kind === 'sheet' ? s.scrimSheet : s.scrimDialog)}
            onClick={onClose}
        >
            <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                className={kind === 'sheet' ? s.sheet : s.dialog}
                onClick={(e) => e.stopPropagation()}
            >
                {kind === 'sheet' ? <div className={s.handle} aria-hidden="true" /> : null}
                {title ? (
                    <h2 id={titleId} className={s.overlayTitle}>
                        {title}
                    </h2>
                ) : null}
                {children}
            </div>
        </div>,
        document.body
    );
}

export function Sheet(props: OverlayProps) {
    return <Overlay {...props} kind="sheet" />;
}

export function Dialog(props: OverlayProps) {
    return <Overlay {...props} kind="dialog" />;
}

interface ToastItem {
    id: number;
    text: string;
}

const ToastContext = createContext<(text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<ToastItem[]>([]);
    const next = useRef(0);
    const show = useCallback((text: string) => {
        next.current += 1;
        const id = next.current;
        setItems((prev) => [...prev.slice(-2), { id, text }]);
        setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
    }, []);
    return (
        <ToastContext.Provider value={show}>
            {children}
            <div className={s.toasts} role="status" aria-live="polite">
                {items.map((t) => (
                    <div key={t.id} className={s.toast}>
                        {t.text}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    return useContext(ToastContext);
}

interface ListRowProps {
    icon?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    trailing?: ReactNode;
    onClick?: () => void;
}

export function ListRow({ icon, title, subtitle, trailing, onClick }: ListRowProps) {
    const body = (
        <>
            {icon}
            <span className={s.listRowText}>
                <span className={s.listRowTitle} style={{ display: 'block' }}>
                    {title}
                </span>
                {subtitle ? (
                    <span className={s.listRowSubtitle} style={{ display: 'block' }}>
                        {subtitle}
                    </span>
                ) : null}
            </span>
            {trailing ? <span className={s.listRowTrail}>{trailing}</span> : null}
        </>
    );
    return onClick ? (
        <button type="button" className={s.listRow} onClick={onClick}>
            {body}
        </button>
    ) : (
        <div className={s.listRow}>{body}</div>
    );
}

export function ProgressBar({
    value,
    max = 100,
    label,
}: {
    value: number;
    max?: number;
    label: string;
}) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return (
        <div
            className={s.progress}
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
        >
            <div className={s.progressFill} style={{ width: `${pct}%` }} />
        </div>
    );
}

interface SegmentedProps<T extends string> {
    label: string;
    options: Array<{ value: T; label: string }>;
    value: T;
    onChange: (value: T) => void;
}

export function Segmented<T extends string>({
    label,
    options,
    value,
    onChange,
}: SegmentedProps<T>) {
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const i = options.findIndex((o) => o.value === value);
        if (e.key === 'ArrowRight') onChange(options[(i + 1) % options.length].value);
        if (e.key === 'ArrowLeft')
            onChange(options[(i - 1 + options.length) % options.length].value);
    };
    return (
        <div className={s.segmented} role="radiogroup" aria-label={label} onKeyDown={onKey}>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={o.value === value}
                    tabIndex={o.value === value ? 0 : -1}
                    className={cx(s.segment, o.value === value && s.segmentOn)}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
    label: string;
    hint?: ReactNode;
    error?: string | null;
}

export function Field({ label, hint, error, id, className, ...rest }: FieldProps) {
    const auto = useId();
    const inputId = id ?? auto;
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
    return (
        <div className={cx(s.field, className)}>
            <label htmlFor={inputId} className={s.fieldLabel}>
                {label}
            </label>
            <input
                id={inputId}
                className={cx(s.input, error && s.inputError)}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={describedBy}
                {...rest}
            />
            {error ? (
                <p id={`${inputId}-error`} className={s.error} role="alert">
                    {error}
                </p>
            ) : hint ? (
                <p id={`${inputId}-hint`} className={s.hint}>
                    {hint}
                </p>
            ) : null}
        </div>
    );
}

interface OtpFieldProps {
    value: string;
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
    length?: number;
    label: string;
    autoFocus?: boolean;
    disabled?: boolean;
}

export function OtpField({
    value,
    onChange,
    onComplete,
    length = 6,
    label,
    autoFocus,
    disabled,
}: OtpFieldProps) {
    const refs = useRef<Array<HTMLInputElement | null>>([]);
    const digits = Array.from({ length }, (_, i) => value[i] ?? '');

    useEffect(() => {
        if (autoFocus) refs.current[0]?.focus();
    }, [autoFocus]);

    const set = (next: string) => {
        const clean = next.replace(/\D/g, '').slice(0, length);
        onChange(clean);
        if (clean.length === length) onComplete?.(clean);
        refs.current[Math.min(clean.length, length - 1)]?.focus();
    };

    return (
        <div className={s.otp} role="group" aria-label={label}>
            {digits.map((d, i) => (
                <input
                    key={i}
                    ref={(el) => {
                        refs.current[i] = el;
                    }}
                    className={s.otpBox}
                    inputMode="numeric"
                    autoComplete={i === 0 ? 'one-time-code' : 'off'}
                    aria-label={`Digit ${i + 1}`}
                    maxLength={length}
                    value={d}
                    disabled={disabled}
                    onChange={(e) => {
                        const typed = e.target.value.replace(/\D/g, '');
                        set(value.slice(0, i) + typed);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Backspace' && !digits[i] && i > 0) {
                            e.preventDefault();
                            set(value.slice(0, i - 1));
                        }
                    }}
                    onFocus={(e) => e.target.select()}
                />
            ))}
        </div>
    );
}

export function Pill({ children, selected }: { children: ReactNode; selected?: boolean }) {
    return <span className={cx(s.pill, selected && s.pillSelected)}>{children}</span>;
}

export function initials(name: string | null | undefined): string {
    const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    return (
        (parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')
    ).toUpperCase();
}

export function Avatar({ name, size = 36 }: { name: string | null | undefined; size?: number }) {
    return (
        <span className={s.avatar} style={{ width: size, height: size }} aria-hidden="true">
            {initials(name)}
        </span>
    );
}

export function Skeleton({
    width = '100%',
    height = 16,
    radius = 8,
    style,
}: {
    width?: CSSProperties['width'];
    height?: CSSProperties['height'];
    radius?: number;
    style?: CSSProperties;
}) {
    return (
        <span
            className={s.skeleton}
            style={{ width, height, borderRadius: radius, ...style }}
            aria-hidden="true"
        />
    );
}

interface StateProps {
    icon?: ReactNode;
    title: string;
    body?: ReactNode;
    actions?: ReactNode;
}

export function EmptyState({ icon, title, body, actions }: StateProps) {
    return (
        <div className={s.state}>
            {icon ? <div className={s.stateIcon}>{icon}</div> : null}
            <h1 className={s.stateTitle}>{title}</h1>
            {body ? <p className={s.stateBody}>{body}</p> : null}
            {actions ? <div className={s.stateActions}>{actions}</div> : null}
        </div>
    );
}

export function ErrorState({
    code,
    onRetry,
    onReport,
}: {
    code?: string;
    onRetry?: () => void;
    onReport?: () => void;
}) {
    return (
        <div className={s.state} role="alert">
            <div className={cx(s.stateIcon, s.stateIconError)}>
                <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
                    <circle cx="16" cy="16" r="14" fill="currentColor" />
                    <rect
                        x="14.5"
                        y="8"
                        width="3"
                        height="11"
                        rx="1.5"
                        fill="var(--web-on-brand)"
                    />
                    <circle cx="16" cy="23" r="1.8" fill="var(--web-on-brand)" />
                </svg>
            </div>
            <h1 className={s.stateTitle}>Something went wrong</h1>
            <p className={s.stateBody}>
                It's not you. Try again, and if it keeps happening, tell us.
            </p>
            {code ? <p className={s.stateCode}>Error code {code}</p> : null}
            <div className={s.stateActions}>
                {onRetry ? (
                    <Button block onClick={onRetry}>
                        Try again
                    </Button>
                ) : null}
                {onReport ? (
                    <Button variant="link" block onClick={onReport}>
                        Report it
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

export function Banner({
    tone = 'dark',
    icon,
    children,
}: {
    tone?: 'dark' | 'error' | 'info';
    icon?: ReactNode;
    children: ReactNode;
}) {
    const toneClass = { dark: undefined, error: s.bannerError, info: s.bannerInfo }[tone];
    return (
        <div className={cx(s.banner, toneClass)} role="status">
            {icon}
            <span>{children}</span>
        </div>
    );
}

interface OptionCardProps {
    title: string;
    body?: string;
    selected: boolean;
    onSelect: () => void;
}

export function OptionCard({ title, body, selected, onSelect }: OptionCardProps) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            className={cx(s.option, selected && s.optionOn)}
            onClick={onSelect}
        >
            <span className={s.radio} aria-hidden="true" />
            <span>
                <span className={s.optionTitle} style={{ display: 'block' }}>
                    {title}
                </span>
                {body ? (
                    <span className={s.optionBody} style={{ display: 'block' }}>
                        {body}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

export function Steps({ steps }: { steps: Array<{ title: string; body: string }> }) {
    return (
        <ol className={s.steps}>
            {steps.map((step, i) => (
                <li key={step.title} className={s.step}>
                    <span className={s.stepNumber} aria-hidden="true">
                        {i + 1}
                    </span>
                    <span className={s.stepTitle}>{step.title}</span>
                    <span className={s.stepBody}>{step.body}</span>
                </li>
            ))}
        </ol>
    );
}

export function Lead({ children }: { children: ReactNode }) {
    return <p className={s.lead}>{children}</p>;
}

export function useOnline(): boolean {
    const [online, setOnline] = useState(() =>
        typeof navigator === 'undefined' ? true : navigator.onLine
    );
    useEffect(() => {
        const on = () => setOnline(true);
        const off = () => setOnline(false);
        window.addEventListener('online', on);
        window.addEventListener('offline', off);
        return () => {
            window.removeEventListener('online', on);
            window.removeEventListener('offline', off);
        };
    }, []);
    return online;
}
