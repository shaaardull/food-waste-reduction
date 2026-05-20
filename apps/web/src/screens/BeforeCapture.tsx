import { Capture } from '../components/Capture';
import { useParams } from 'react-router-dom';

export function BeforeCapture() {
  const { id = '' } = useParams();
  return (
    <Capture
      sessionId={id}
      phase="before"
      title="Before photo"
      blurb="Hold the camera over your plates. Try to fit everything you ordered in the frame."
      nextPath={`/sessions/${id}`}
      cta="Send to kitchen"
    />
  );
}
