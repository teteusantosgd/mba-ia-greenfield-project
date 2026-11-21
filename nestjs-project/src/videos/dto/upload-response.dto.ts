import { ApiProperty } from '@nestjs/swagger';
import { PART_SIZE_BYTES, PART_URL_TTL_SECONDS } from '../videos.constants';

class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  /** Exact body length the PUT must send; the URL signs it. */
  @ApiProperty({ example: PART_SIZE_BYTES })
  size: number;

  @ApiProperty()
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  urls: PartUrlDto[];

  @ApiProperty({ example: PART_URL_TTL_SECONDS })
  expires_in: number;
}

class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: PART_SIZE_BYTES })
  size: number;
}

export class UploadStatusResponseDto {
  @ApiProperty({ example: PART_SIZE_BYTES })
  part_size: number;

  @ApiProperty({ example: 4 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
