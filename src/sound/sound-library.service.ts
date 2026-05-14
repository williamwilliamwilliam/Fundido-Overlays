import * as fs from 'fs';
import * as path from 'path';

export interface SoundIndexProgress {
  /** Number of sound files found so far. */
  filesFound: number;
  /** The directory currently being scanned. */
  currentFolder: string;
  /** Whether the scan has completed. */
  complete: boolean;
  /** Whether the scan was cancelled before completing. */
  cancelled: boolean;
}

/**
 * Manages scanning configured folder paths for .ogg and .mp3 sound files.
 *
 * The scan is async and supports cancellation via a shared cancel token that
 * the caller can flip at any time. Progress callbacks are fired as files are
 * discovered so the UI can show a live count.
 */
export class SoundLibraryService {
  private soundFileIndex: string[] = [];
  private readonly activeCancelToken: { cancelled: boolean } = { cancelled: false };
  private indexingInProgress = false;

  public getIndex(): string[] {
    return this.soundFileIndex;
  }

  public isIndexingInProgress(): boolean {
    return this.indexingInProgress;
  }

  public cancelIndexing(): void {
    this.activeCancelToken.cancelled = true;
  }

  /**
   * Kicks off a recursive scan of all given folder paths.
   * The previous index is cleared before scanning begins.
   * The `onProgress` callback fires after each file is found, and once more
   * when the scan completes (with `complete: true`).
   */
  public async indexFolders(
    folderPaths: string[],
    onProgress: (progress: SoundIndexProgress) => void,
  ): Promise<void> {
    // Reset state for this new run
    this.activeCancelToken.cancelled = false;
    this.indexingInProgress = true;
    this.soundFileIndex = [];

    const SOUND_FILE_EXTENSIONS = new Set(['.ogg', '.mp3']);
    const foundFiles: string[] = [];
    const cancelToken = this.activeCancelToken;

    const walkDirectory = async (directoryPath: string): Promise<void> => {
      if (cancelToken.cancelled) return;

      let directoryEntries: string[];
      try {
        directoryEntries = await fs.promises.readdir(directoryPath);
      } catch {
        // Skip directories we cannot read (permissions, broken links, etc.)
        return;
      }

      for (const entryName of directoryEntries) {
        if (cancelToken.cancelled) return;

        const entryFullPath = path.join(directoryPath, entryName);

        let entryStat: fs.Stats;
        try {
          entryStat = await fs.promises.stat(entryFullPath);
        } catch {
          continue;
        }

        if (entryStat.isDirectory()) {
          await walkDirectory(entryFullPath);
        } else if (entryStat.isFile()) {
          const entryExtension = path.extname(entryName).toLowerCase();
          const isSoundFile = SOUND_FILE_EXTENSIONS.has(entryExtension);
          if (isSoundFile) {
            foundFiles.push(entryFullPath);
            onProgress({
              filesFound: foundFiles.length,
              currentFolder: directoryPath,
              complete: false,
              cancelled: false,
            });
          }
        }
      }
    };

    for (const folderPath of folderPaths) {
      if (cancelToken.cancelled) break;
      await walkDirectory(folderPath);
    }

    const wasCancelled = cancelToken.cancelled;
    if (!wasCancelled) {
      // Only commit the index if the scan completed fully
      this.soundFileIndex = foundFiles;
    }

    this.indexingInProgress = false;

    onProgress({
      filesFound: foundFiles.length,
      currentFolder: '',
      complete: true,
      cancelled: wasCancelled,
    });
  }
}
