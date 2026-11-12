import type { CSSProperties } from "react";
import { AVATAR_SRC, initials } from "../lib/profiles";
import type { ProfileAvatarId } from "../types";

interface ProfileAvatarProps {
  name: string;
  color?: string;
  avatar?: ProfileAvatarId;
  /** Illustrations get a colour ring unless the admin turns it off. */
  ring?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * One avatar primitive for every surface: the chosen illustrated face when the
 * admin assigned one, otherwise the coloured initials. The profile colour stays
 * in `--profile-color` so page-level rings/halos keep working in both modes.
 */
export default function ProfileAvatar({
  name,
  color,
  avatar,
  ring = true,
  className,
  style,
}: ProfileAvatarProps) {
  const photo = avatar ? AVATAR_SRC[avatar] : null;
  const classes = `avatar${photo ? " avatar--photo" : ""}${
    photo && ring === false ? " avatar--no-ring" : ""
  }${className ? ` ${className}` : ""}`;

  return (
    <span
      className={classes}
      style={
        {
          "--profile-color": color,
          ...style,
          ...(photo ? { background: "transparent" } : {}),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {photo ? <img className="avatar-photo" src={photo} alt="" decoding="async" /> : initials(name)}
    </span>
  );
}
