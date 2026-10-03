import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBase64,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsTimeZone } from '../../common/validators';

export const DIRECTIONS = ['IN', 'OUT', 'BOTH'] as const;

export class EmployeeRefDto {
  @ApiProperty() @IsString() @MaxLength(64) employeeId: string;
}

export class EnrollByPhotoDto extends EmployeeRefDto {
  @ApiProperty({ description: 'Base64 JPEG. The terminal rejects anything over 32KB decoded.' })
  @IsBase64()
  photoBase64: string;
}

export class RemoteEnrollDto extends EmployeeRefDto {
  @ApiPropertyOptional({ enum: ['RemoteEnrollFace', 'RemoteEnrollFP', 'RemoteEnrollCard'], default: 'RemoteEnrollFace' })
  @IsOptional()
  @IsIn(['RemoteEnrollFace', 'RemoteEnrollFP', 'RemoteEnrollCard'])
  backup?: 'RemoteEnrollFace' | 'RemoteEnrollFP' | 'RemoteEnrollCard';
}

export class ClaimSlotDto extends EmployeeRefDto {
  @ApiPropertyOptional({ default: true, description: "Overwrite the keypad-typed name with the employee's." })
  @IsOptional()
  @IsBoolean()
  renameOnDevice?: boolean;

  @ApiPropertyOptional({ default: true, description: 'Harvest the face template in the same call.' })
  @IsOptional()
  @IsBoolean()
  captureTemplate?: boolean;
}

export class ProvisionTerminalDto {
  @ApiProperty({ description: 'DeviceSerialNo printed on the terminal, e.g. DJ20250307014' })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  serialNo: string;

  @ApiProperty() @IsString() siteId: string;

  @ApiPropertyOptional({ description: 'e.g. "Main lobby — entry"' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ description: 'Terminals sharing a gate name at a site form one gate (§4.3).' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  gateName: string;

  @ApiProperty({ enum: DIRECTIONS, description: 'Required: IN / OUT for a directional gate, BOTH for a single bidirectional terminal.' })
  @IsIn(DIRECTIONS)
  direction: (typeof DIRECTIONS)[number];

  @ApiPropertyOptional({ description: "IANA timezone the device clock is set to; defaults to the site's." })
  @IsOptional()
  @IsTimeZone()
  clockTimezone?: string;
}

export class UpdateTerminalDto {
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) gateName?: string;
  /** Applies to punches received afterwards; re-evaluate history explicitly for the past (§4.3). */
  @IsOptional() @IsIn(DIRECTIONS) direction?: (typeof DIRECTIONS)[number];
  @IsOptional() @IsTimeZone() clockTimezone?: string | null;
}

/** Upper bound on employees × devices in a single batch. */
export const MAX_TEMPLATE_BATCH = 500;

export class CaptureTemplatesBody {
  @ApiProperty() @IsString() sourceDeviceId: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_TEMPLATE_BATCH)
  @IsString({ each: true })
  employeeIds: string[];

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() refresh?: boolean;
}

export class DistributeTemplatesBody {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayNotEmpty() @IsString({ each: true }) employeeIds: string[];
  @ApiProperty({ type: [String] }) @IsArray() @ArrayNotEmpty() @IsString({ each: true }) deviceIds: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() sourceDeviceId?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() skipEnrolled?: boolean;
}

// Internal shapes used by TerminalTemplateService (subject = employee).
export interface SubjectRefDto {
  subjectType: string;
  subjectId: string;
}

export interface CaptureTemplatesDto {
  sourceDeviceId: string;
  subjects: SubjectRefDto[];
  refresh?: boolean;
}

export interface DistributeTemplatesDto {
  subjects: SubjectRefDto[];
  deviceIds: string[];
  sourceDeviceId?: string;
  skipEnrolled?: boolean;
}

export const asSubjects = (employeeIds: string[]): SubjectRefDto[] =>
  [...new Set(employeeIds)].map((subjectId) => ({ subjectType: 'EMPLOYEE', subjectId }));
