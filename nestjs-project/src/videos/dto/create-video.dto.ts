import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_TITLE_LENGTH,
  MAX_VIDEO_SIZE_BYTES,
} from '../videos.constants';
import type { AcceptedContentType } from '../videos.constants';

// Postgres rejects NUL in text columns; caught here, before the multipart
// upload is opened.
// eslint-disable-next-line no-control-regex
const WITHOUT_NUL = /^[^\u0000]*$/;
const NUL_MESSAGE = '$property must not contain NUL characters';

export class CreateVideoDto {
  /** Original file name, kept for the download. */
  @IsString()
  @Length(1, 255)
  @Matches(WITHOUT_NUL, { message: NUL_MESSAGE })
  filename: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  @IsIn(ACCEPTED_CONTENT_TYPES)
  content_type: AcceptedContentType;

  /** Defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @Length(1, MAX_TITLE_LENGTH)
  @Matches(WITHOUT_NUL, { message: NUL_MESSAGE })
  title?: string;
}
