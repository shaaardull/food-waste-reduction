import { useTranslation } from 'react-i18next';
import { Capture } from '../components/Capture';
import { useParams } from 'react-router-dom';

export function AfterCapture() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  return (
    <Capture
      sessionId={id}
      phase="after"
      step={2}
      title={t('capture.after_title')}
      blurb={t('capture.after_blurb')}
      nextPath={`/sessions/${id}`}
      cta={t('capture.after_cta')}
    />
  );
}
