import path from 'path';
import { app, UPLOAD_DIR } from './app';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload directory: ${path.resolve(UPLOAD_DIR)}`);
});
