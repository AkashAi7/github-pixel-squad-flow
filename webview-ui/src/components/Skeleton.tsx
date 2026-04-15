interface SkeletonProps {
  variant?: 'text' | 'avatar' | 'chip' | 'card';
  width?: string | number;
  height?: string | number;
  className?: string;
}

export function Skeleton({ variant = 'text', width, height, className = '' }: SkeletonProps) {
  const variantClass = variant === 'text' ? 'skeleton-text' : `skeleton-${variant}`;
  const style: React.CSSProperties = {};

  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  return <div className={`skeleton ${variantClass} ${className}`} style={style} aria-hidden="true" />;
}

export function SkeletonRoom() {
  return (
    <div className="skeleton-room" aria-label="Loading room">
      <div className="skeleton-room__header">
        <div className="skeleton skeleton-room__icon" />
        <div className="skeleton-room__title">
          <div className="skeleton skeleton-text skeleton-text--title" />
          <div className="skeleton skeleton-text skeleton-text--short" />
        </div>
      </div>
      <div className="skeleton-room__agents">
        <div className="skeleton skeleton-avatar" />
        <div className="skeleton skeleton-avatar" />
      </div>
    </div>
  );
}

export function SkeletonTask() {
  return (
    <div className="skeleton-task" aria-label="Loading task">
      <div className="skeleton-task__header">
        <div className="skeleton skeleton-text skeleton-text--medium" />
        <div className="skeleton skeleton-task__status" />
      </div>
      <div className="skeleton skeleton-text" />
      <div className="skeleton skeleton-text skeleton-text--short" />
    </div>
  );
}

export function SkeletonInspector() {
  return (
    <div className="skeleton-inspector" aria-label="Loading inspector">
      <div className="skeleton-inspector__section">
        <div className="skeleton skeleton-text skeleton-text--title" />
        <div className="skeleton skeleton-text" />
        <div className="skeleton skeleton-text skeleton-text--medium" />
      </div>
      <div className="skeleton-inspector__section">
        <div className="skeleton skeleton-text skeleton-text--short" />
        <div className="skeleton skeleton-chip" />
        <div className="skeleton skeleton-chip" />
      </div>
    </div>
  );
}

export function FactoryBoardSkeleton() {
  return (
    <div className="factory-loading" aria-label="Loading factory board">
      <div className="factory-loading__column">
        <SkeletonRoom />
        <SkeletonRoom />
      </div>
      <div className="factory-loading__column">
        <SkeletonRoom />
      </div>
    </div>
  );
}
